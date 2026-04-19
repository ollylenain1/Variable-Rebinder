// Blueprint: Variable Mapper — code.js  v3.0
// ─────────────────────────────────────────────────────────────────────────────
// Key improvements over v2.x:
//   • Chunked node walking with inter-chunk yields — no timeouts on huge files
//   • All nodes walked regardless of visibility (hidden layers are always included)
//   • Concurrent loadAsync() with capped concurrency (avoids memory spikes)
//   • Progress messages sent to UI during long scans
//   • Broken/unresolved variables surfaced as a dedicated category
//   • Bulk remap by source library collection supported
//   • Node-override spreading fixed (includes representative node itself)
//   • Better variable key/name lookup with multi-tier fallback

figma.showUI(__html__, {
  width: 500,
  height: 740,
  title: "Blueprint: Variable Mapper",
});

// ─── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 400; // nodes processed per tick before yielding
const LOAD_CONCURRENCY = 20; // max parallel loadAsync() calls
const PROGRESS_INTERVAL = 500; // ms between progress messages
const UI_PREFERENCES_KEY = "uiPreferences.v1";

// Fields exposed in boundVariables that setBoundVariable cannot set
const UNSETTABLE_FIELDS = new Set(["textRangeFills", "textRangeStrokes"]);

// Paint array fields — must use setBoundVariableForPaint + node[field] assignment
const PAINT_FIELDS = new Set(["fills", "strokes"]);
const variableCache = new Map(); // key: variableId -> value: variable

// ─── Utilities ────────────────────────────────────────────────────────────────

function sanitizeUIPreferences(raw) {
  const prefs = raw && typeof raw === "object" ? raw : {};
  const validScope =
    prefs.scope === "selection" ||
    prefs.scope === "page" ||
    prefs.scope === "file"
      ? prefs.scope
      : "selection";
  const validThemeMode =
    prefs.themeMode === "auto" ||
    prefs.themeMode === "light" ||
    prefs.themeMode === "dark"
      ? prefs.themeMode
      : "auto";
  const recentCollectionKeys = Array.isArray(prefs.recentCollectionKeys)
    ? prefs.recentCollectionKeys.length > 8
      ? prefs.recentCollectionKeys
          .filter((value) => typeof value === "string" && value.trim().length > 0)
          .slice(0, 8)
      : prefs.recentCollectionKeys.filter(
          (value) => typeof value === "string" && value.trim().length > 0,
        )
    : [];

  return {
    scope: validScope,
    themeMode: validThemeMode,
    recentCollectionKeys,
  };
}

async function getUIPreferences() {
  try {
    const stored = await figma.clientStorage.getAsync(UI_PREFERENCES_KEY);
    return sanitizeUIPreferences(stored);
  } catch (err) {
    console.warn("clientStorage getAsync failed:", String(err));
    return sanitizeUIPreferences(null);
  }
}

async function saveUIPreferences(partial) {
  try {
    const current = await getUIPreferences();
    const next = sanitizeUIPreferences(
      Object.assign({}, current || {}, partial || {}),
    );
    await figma.clientStorage.setAsync(UI_PREFERENCES_KEY, next);
    return next;
  } catch (err) {
    console.warn("clientStorage setAsync failed:", String(err));
    return sanitizeUIPreferences(partial);
  }
}

/** Yield control back to Figma so it can process other events. */
function yieldTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Scan cancellation flag
let scanCancelled = false;

function handleCancelScan() {
  scanCancelled = true;
}

function resetScanCancelled() {
  scanCancelled = false;
}

function getCanonicalVariableId(id, idRemap) {
  if (!id) return id;
  return idRemap && idRemap[id] ? idRemap[id] : id;
}

async function getCachedVariable(id) {
  if (!id) return null;

  if (variableCache.has(id)) {
    return variableCache.get(id);
  }

  try {
    const variable = await figma.variables.getVariableByIdAsync(id);
    if (variable) {
      variableCache.set(id, variable);
    }
    return variable || null;
  } catch (err) {
    console.warn("Variable lookup failed:", id, err);
    return null;
  }
}

function shouldScanNodeForVariables(node) {
  return !!node.boundVariables || node.type === "TEXT";
}

function collectNodesForScan(roots) {
  const allNodes = [];
  const needLoad = [];

  roots.forEach((root) => {
    const stack = [{ node: root, hasInstanceAncestor: false }];
    while (stack.length > 0) {
      const current = stack.pop();
      const node = current.node;
      allNodes.push(node);

      const hasVars = node.boundVariables != null;
      if (
        (node.type === "TEXT" && hasVars) ||
        (hasVars && current.hasInstanceAncestor)
      ) {
        needLoad.push(node);
      }

      if ("children" in node) {
        const childHasInstanceAncestor =
          current.hasInstanceAncestor || node.type === "INSTANCE";
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({
            node: node.children[i],
            hasInstanceAncestor: childHasInstanceAncestor,
          });
        }
      }
    }
  });

  return { allNodes, needLoad };
}

function collectNodesForRebind(roots, includeHidden) {
  const nodes = [];

  roots.forEach((root) => {
    const stack = [{ node: root, hasHiddenAncestor: false }];
    while (stack.length > 0) {
      const current = stack.pop();
      const node = current.node;
      const selfHidden = "visible" in node && node.visible === false;
      const isHidden = current.hasHiddenAncestor || selfHidden;

      if (includeHidden !== false || !isHidden) {
        nodes.push(node);
      }

      if ("children" in node) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push({
            node: node.children[i],
            hasHiddenAncestor: isHidden,
          });
        }
      }
    }
  });

  return nodes;
}

/**
 * Run an async task for each item in `items` with at most `concurrency`
 * promises in-flight simultaneously.
 */
async function pMap(items, fn, concurrency) {
  const len = items.length;
  if (len === 0) return [];

  // For small batches, sequential processing avoids Promise allocation overhead.
  // Workers start incurring overhead below ~half the concurrency limit.
  if (len <= concurrency * 0.5) {
    const results = new Array(len);
    for (let i = 0; i < len; i++) {
      results[i] = await fn(items[i], i);
    }
    return results;
  }

  const results = new Array(len);
  let idx = 0;

  async function worker() {
    while (idx < len) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = [];
  const workerCount = Math.min(concurrency, len);
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/** Extract bound variable ID→alias entries from node.boundVariables. */
function getBoundVariableIds(node) {
  const ids = new Set();
  const bv = node.boundVariables;
  if (!bv) return ids;
  for (const field of Object.keys(bv)) {
    const val = bv[field];
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && item.type === "VARIABLE_ALIAS") ids.add(item.id);
      }
    } else if (val.type === "VARIABLE_ALIAS") {
      ids.add(val.id);
    }
  }
  return ids;
}

/**
 * Collect paint-level variable alias IDs from TEXT segment fills/strokes that
 * are NOT already visible in node.boundVariables.
 *
 * When a text node has mixed fills (e.g. body color at node level, link color
 * on a specific character range), node.boundVariables may show figma.mixed for
 * fills and not expose the per-segment variable IDs. This function discovers
 * those segment-only IDs so they are included in the scan.
 *
 * IDs that already appear in getBoundVariableIds(node) are excluded here to
 * avoid creating duplicate variable cards in the UI.
 */
function getSegmentBoundVariableIds(node) {
  const ids = new Set();
  if (node.type !== "TEXT" || typeof node.getStyledTextSegments !== "function")
    return ids;

  // Collect node-level IDs first so we can exclude them below
  const nodeLevelIds = getBoundVariableIds(node);

  try {
    // Note: getStyledTextSegments only accepts 'fills' for paint properties, not 'strokes'
    const segs = node.getStyledTextSegments(["fills"]);
    for (const seg of segs) {
      const paints = seg["fills"];
      if (!Array.isArray(paints)) continue;
      for (const paint of paints) {
        const alias =
          paint && paint.boundVariables && paint.boundVariables.color;
        if (
          alias &&
          alias.type === "VARIABLE_ALIAS" &&
          !nodeLevelIds.has(alias.id)
        ) {
          ids.add(alias.id);
        }
      }
    }
  } catch (err) {
    debugWarn("getSegmentBoundVariableIds failed:", err);
  }
  return ids;
}

/**
 * Build the full list of {field, index, id, segmentRange} entries for rebinding.
 *
 * TEXT nodes can have two distinct layers of paint variable bindings:
 *   1. Node-level: node.boundVariables.fills — applies to the whole text node
 *      (e.g. body text color bound to "Neutral 900")
 *   2. Segment-level: per-character-range overrides from getStyledTextSegments
 *      (e.g. a linked word bound to "Interactive Blue")
 *
 * These are INDEPENDENT — a single text layer can have BOTH simultaneously.
 * For example:
 *   - Characters 0–20 use the node-level fill variable (body color)
 *   - Characters 5–10 (a link) override fills with a different variable
 *
 * The correct strategy is:
 *   - Keep ALL node-level entries UNLESS that specific variable ID is entirely
 *     superseded by segment-level entries covering the same field+paintIndex.
 *   - Add segment-level entries for each distinct character range.
 *   - Never drop a node-level entry just because *some* segments have bindings —
 *     only drop it if *that exact variable* appears exclusively in segments.
 */
function getBoundVariableEntries(node, textFillSegments) {
  const entries = [];
  const bv = node.boundVariables;

  if (bv) {
    for (const field of Object.keys(bv)) {
      if (UNSETTABLE_FIELDS.has(field)) continue;
      const val = bv[field];
      if (!val) continue;
      if (Array.isArray(val)) {
        for (let i = 0; i < val.length; i++) {
          const item = val[i];
          if (item && item.type === "VARIABLE_ALIAS") {
            entries.push({ field, index: i, id: item.id, segmentRange: null });
          }
        }
      } else if (val.type === "VARIABLE_ALIAS") {
        entries.push({ field, index: null, id: val.id, segmentRange: null });
      }
    }
  }

  // TEXT nodes: additionally collect per-segment paint bindings.
  if (
    node.type === "TEXT" &&
    typeof node.getStyledTextSegments === "function"
  ) {
    try {
      // getStyledTextSegments only supports 'fills' for paint, not 'strokes'.
      // Strokes on TEXT nodes are node-level only and already captured above.
      const segs = textFillSegments || node.getStyledTextSegments(["fills"]);

      const segEntries = [];
      const segOnlyKeys = new Set();
      const nodeLevelIds = {};

      for (const e of entries) {
        const k =
          e.field +
          ":" +
          (e.index !== null && e.index !== undefined ? e.index : 0);
        if (!nodeLevelIds[k]) nodeLevelIds[k] = new Set();
        nodeLevelIds[k].add(e.id);
      }

      for (const seg of segs) {
        const paints = seg["fills"];
        if (!Array.isArray(paints)) continue;
        for (let i = 0; i < paints.length; i++) {
          const alias =
            paints[i] &&
            paints[i].boundVariables &&
            paints[i].boundVariables.color;
          if (alias && alias.type === "VARIABLE_ALIAS") {
            segEntries.push({
              field: "fills",
              index: i,
              id: alias.id,
              segmentRange: { start: seg.start, end: seg.end },
            });
            const k = "fills:" + i;
            const nodeIds = nodeLevelIds[k];
            if (nodeIds && nodeIds.has(alias.id)) {
              segOnlyKeys.add("fills:" + i + ":" + alias.id);
            }
          }
        }
      }

      for (const e of segEntries) entries.push(e);

      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.segmentRange !== null) continue;
        const k =
          e.field +
          ":" +
          (e.index !== null && e.index !== undefined ? e.index : 0) +
          ":" +
          e.id;
        if (segOnlyKeys.has(k)) {
          entries.splice(i, 1);
        }
      }
    } catch (err) {
      debugWarn("getBoundVariableEntries segment scan failed:", err);
    }
  }

  return entries;
}

/** Walk up the parent chain to find the page name. */
function getPageName(node) {
  let cur = node;
  while (cur && cur.parent) {
    if (cur.parent.type === "DOCUMENT") return cur.name;
    cur = cur.parent;
  }
  return figma.currentPage ? figma.currentPage.name : "Unknown Page";
}

/** Return the nearest INSTANCE ancestor, or null. */
function getNearestInstance(node) {
  let cur = node.parent;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    if (cur.type === "INSTANCE") return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Return true if `node` or any ancestor (up to PAGE) has visible===false.
 * Hidden nodes are still scanned and remapped — this is purely for display.
 */
function isEffectivelyHidden(node) {
  let cur = node;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    if ("visible" in cur && cur.visible === false) return true;
    cur = cur.parent;
  }
  return false;
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

/** Cached selection IDs from scan time (selection is lost when UI gains focus). */
let cachedSelectionIds = [];
/** Last scanned per-variable node usage, kept in controller memory for lazy UI fetches. */
let lastScanNodesByVariable = {};
/**
 * Maps each scanned instance-child node ID → true, for every node that
 * (a) lives inside a INSTANCE ancestor and (b) has at least one bound variable.
 * During rebind, applyOverrideToDescendants resolves these IDs via
 * figma.getNodeByIdAsync so they can be added to nodeById even when the rebind
 * scope doesn't include the instance root itself.
 */
let lastScanInstanceChildNodeIds = {};
/** Last scanned lookup maps, reused by rebind to avoid resending large payloads from the UI. */
let lastScanLookupMaps = null;

function debugWarn(context, err) {
  console.warn(context, err ? String(err) : "");
}

async function getRoots(scope, selectionIds) {
  if (scope === "selection") {
    const ids =
      selectionIds && selectionIds.length > 0
        ? selectionIds
        : figma.currentPage.selection.map((n) => n.id);
    if (ids.length === 0) return null;

    const nodes = [];
    for (const id of ids) {
      try {
        const node = await figma.getNodeByIdAsync(id);
        if (node) nodes.push(node);
      } catch (err) {
        debugWarn("getRoots could not resolve selected node:", err);
      }
    }
    return nodes.length > 0 ? nodes : null;
  }

  if (scope === "page") {
    await figma.currentPage.loadAsync();
    return [figma.currentPage];
  }

  // "file" — load every page before walking
  await figma.loadAllPagesAsync();
  return figma.root.children;
}

function setRelaunchForRoots(scope, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return;
  const description =
    scope === "selection"
      ? "Re-open Variable Mapper for this selection"
      : scope === "page"
        ? "Re-open Variable Mapper for this page"
        : "Re-open Variable Mapper for this file";

  for (const root of roots) {
    if (!root || typeof root.setRelaunchData !== "function") continue;
    try {
      root.setRelaunchData({ open: description });
    } catch (err) {
      console.warn("setRelaunchData failed:", String(err));
    }
  }
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function handleScan({ scope }) {
  try {
    // Reset cancellation flag for new scan
    resetScanCancelled();

    if (scope === "selection" && figma.currentPage.selection.length === 0) {
      figma.ui.postMessage({
        type: "scan-result",
        error: "No nodes selected. Please select something first.",
      });
      return;
    }

    // Check if scan was cancelled
    if (scanCancelled) {
      figma.ui.postMessage({
        type: "scan-result",
        message: "Scan cancelled",
      });
      return;
    }

    // Capture selection NOW before the user clicks into the plugin panel
    cachedSelectionIds =
      scope === "selection" ? figma.currentPage.selection.map((n) => n.id) : [];

    figma.ui.postMessage({
      type: "scan-progress",
      message: "Loading pages…",
      pct: 0,
    });

    const roots = await getRoots(scope, cachedSelectionIds);
    if (!roots) {
      figma.ui.postMessage({
        type: "scan-result",
        error: "No nodes selected. Please select something first.",
      });
      return;
    }

    // ── Step 1: Collect all nodes ────────────────────────────────────────────
    figma.ui.postMessage({
      type: "scan-progress",
      message: "Walking node tree…",
      pct: 5,
      scannedNodes: 0,
    });

    // Check for cancellation
    if (scanCancelled) {
      figma.ui.postMessage({
        type: "scan-result",
        message: "Scan cancelled",
      });
      return;
    }

    const scanNodes = collectNodesForScan(roots);
    const allNodes = scanNodes.allNodes.filter(shouldScanNodeForVariables);
    const needLoad = scanNodes.needLoad.filter(shouldScanNodeForVariables);

    // ── Step 2: Load hidden / instance nodes in batches ──────────────────────
    figma.ui.postMessage({
      type: "scan-progress",
      message: `Loading ${allNodes.length} nodes…`,
      pct: 10,
      scannedNodes: 0,
      totalNodes: allNodes.length,
    });

    if (needLoad.length > 0) {
      await pMap(
        needLoad,
        async (node) => {
          // Check for cancellation during load
          if (scanCancelled) return;
          try {
            if (typeof node.loadAsync === "function") await node.loadAsync();
          } catch (err) {
            debugWarn("scan loadAsync failed:", err);
          }
        },
        LOAD_CONCURRENCY,
      );

      // Check for cancellation after loads
      if (scanCancelled) {
        figma.ui.postMessage({
          type: "scan-result",
          message: "Scan cancelled",
        });
        return;
      }
    }

    // ── Step 3: Fetch collections early so results can stream while scanning ─
    figma.ui.postMessage({
      type: "scan-progress",
      message: "Fetching library metadata…",
      pct: 16,
      scannedNodes: 0,
      totalNodes: allNodes.length,
    });

    // Check for cancellation
    if (scanCancelled) {
      figma.ui.postMessage({
        type: "scan-result",
        message: "Scan cancelled",
      });
      return;
    }

    let remoteCollections = [];
    try {
      const raw =
        await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      remoteCollections = raw.map((c) => ({
        key: c.key,
        name: c.name,
        libraryName: c.libraryName,
        isLocal: false,
      }));
    } catch (e) {
      console.warn(
        "getAvailableLibraryVariableCollectionsAsync failed:",
        String(e),
      );
    }

    const remoteCollectionById = {};
    for (const c of remoteCollections) {
      remoteCollectionById["VariableCollectionId:" + c.key] = c;
    }

    let localCollections = [];
    try {
      const raw = await figma.variables.getLocalVariableCollectionsAsync();
      localCollections = raw.map((c) => ({
        key: c.key,
        name: c.name,
        libraryName: "This file",
        isLocal: true,
        localId: c.id,
      }));
    } catch (e) {
      console.warn("getLocalVariableCollectionsAsync failed:", String(e));
    }

    figma.ui.postMessage({
      type: "scan-start",
      libraryCollections: remoteCollections.concat(localCollections),
      stats: {
        totalNodes: allNodes.length,
        hiddenLayerCount: 0,
        brokenCount: 0,
        variableCount: 0,
        discoveredCount: 0,
        resolvedVariableCount: 0,
        scannedNodes: 0,
      },
    });

    // ── Step 4: Stream resolved variables while scanning nodes ───────────────
    figma.ui.postMessage({
      type: "scan-progress",
      message: "Scanning for bound variables…",
      pct: 20,
      scannedNodes: 0,
      totalNodes: allNodes.length,
    });

    const variableIdSet = new Set();
    const nodeLevelIdSet = new Set();
    const nodesByVariableMap = {};
    const instanceChildNodeIds = {}; // node.id → true, for all instance-child nodes with bound variables
    const segmentBoundIdsByNode = {};
    const localCollectionCache = {};
    const finalVariableInfo = [];
    const seenCanonical = new Set();
    const canonicalByNameCollection = {};
    const resolvedVariableIds = new Set();
    const idRemap = {};
    const STREAM_VARIABLE_BATCH_SIZE = 40;
    let streamedVariableCount = 0;
    let resolvedVariableCount = 0;
    let lastProgressAt = Date.now();
    const nameCollectionKey = (v) => v.name + "\x00" + (v.collectionId || "");

    const buildVariableInfo = (variable) => {
      if (!variable) return null;

      if (variable._error) {
        return {
          id: variable.id,
          name: "(unresolved)",
          key: null,
          resolvedType: "UNKNOWN",
          collectionId: null,
          collectionName: "(unknown — possibly deleted or missing library)",
          libraryName: "(broken reference)",
          remote: true,
          broken: true,
        };
      }

      const localCollection =
        localCollectionCache[variable.variableCollectionId];
      let collectionName, libraryName;

      if (localCollection) {
        collectionName = localCollection.name;
        libraryName = "This file";
      } else {
        const remoteMatch = remoteCollectionById[variable.variableCollectionId];
        if (remoteMatch) {
          collectionName = remoteMatch.name;
          libraryName = remoteMatch.libraryName;
        } else {
          collectionName = "(library collection — library may be detached)";
          libraryName = "(external — check library connections)";
        }
      }

      return {
        id: variable.id,
        _queriedId: variable._queriedId || variable.id,
        name: variable.name,
        key: variable.key,
        resolvedType: variable.resolvedType,
        collectionId: variable.variableCollectionId,
        collectionName,
        libraryName,
        remote: variable.remote,
        broken: false,
      };
    };

    const makeSummaryForVariableId = (variableId) => {
      const entries = Array.from(
        (nodesByVariableMap[variableId] || new Map()).values(),
      );
      let hasInstances = false;
      let hiddenCount = 0;
      for (const entry of entries) {
        if (entry.h) hiddenCount += 1;
        if (entry.t === "INSTANCE") hasInstances = true;
      }
      return {
        c: entries.length,
        h: hiddenCount,
        i: hasInstances,
      };
    };

    const resolveVariableIds = async (ids, scannedNodes) => {
      const queuedIds = Array.from(ids || []).filter(
        (id) => id && !resolvedVariableIds.has(id),
      );
      if (queuedIds.length === 0) return;

      for (let i = 0; i < queuedIds.length; i += STREAM_VARIABLE_BATCH_SIZE) {
        const batchIds = queuedIds.slice(i, i + STREAM_VARIABLE_BATCH_SIZE);
        const rawVariables = await pMap(
          batchIds,
          async (queriedId) => {
            const variable = await getCachedVariable(queriedId);
            if (variable) variable._queriedId = queriedId;

            // Fetch collection inline if not already cached
            if (
              variable &&
              variable.variableCollectionId &&
              !localCollectionCache[variable.variableCollectionId]
            ) {
              try {
                const col = await figma.variables.getVariableCollectionByIdAsync(
                  variable.variableCollectionId,
                );
                localCollectionCache[variable.variableCollectionId] = col || null;
              } catch (err) {
                debugWarn("collection resolution failed:", err);
                localCollectionCache[variable.variableCollectionId] = null;
              }
            }

            return variable || { _error: true, _broken: true, id: queriedId };
          },
          LOAD_CONCURRENCY,
        );

        const streamedVariables = [];
        const streamedSummary = {};
        for (const rawVariable of rawVariables) {
          const variableInfo = buildVariableInfo(rawVariable);
          if (!variableInfo) continue;

          resolvedVariableIds.add(rawVariable._queriedId || rawVariable.id);

          if (variableInfo.broken) {
            finalVariableInfo.push(variableInfo);
            streamedVariables.push(variableInfo);
            streamedSummary[variableInfo.id] = makeSummaryForVariableId(
              variableInfo.id,
            );
            continue;
          }

          const key = nameCollectionKey(variableInfo);
          const canonical = canonicalByNameCollection[key];
          if (canonical && canonical.id !== variableInfo.id) {
            idRemap[variableInfo.id] = canonical.id;
            if (
              variableInfo._queriedId &&
              variableInfo._queriedId !== variableInfo.id
            ) {
              idRemap[variableInfo._queriedId] = canonical.id;
            }
            if (nodesByVariableMap[variableInfo.id]) {
              if (!nodesByVariableMap[canonical.id]) {
                nodesByVariableMap[canonical.id] = new Map();
              }
              for (const [dedupKey, entry] of nodesByVariableMap[
                variableInfo.id
              ]) {
                if (!nodesByVariableMap[canonical.id].has(dedupKey)) {
                  nodesByVariableMap[canonical.id].set(dedupKey, entry);
                }
              }
              delete nodesByVariableMap[variableInfo.id];
            }
            continue;
          }

          if (!canonical) {
            canonicalByNameCollection[key] = variableInfo;
          }
          if (!seenCanonical.has(key)) {
            seenCanonical.add(key);
            finalVariableInfo.push(variableInfo);
            streamedVariables.push(variableInfo);
            streamedSummary[variableInfo.id] = makeSummaryForVariableId(
              variableInfo.id,
            );
          }
        }

        resolvedVariableCount += rawVariables.length;
        streamedVariableCount += streamedVariables.length;

        if (streamedVariables.length > 0) {
          figma.ui.postMessage({
            type: "scan-chunk",
            variables: streamedVariables.map((v) => ({
              id: v.id,
              name: v.name,
              key: v.key,
              resolvedType: v.resolvedType,
              collectionId: v.collectionId,
              collectionName: v.collectionName,
              libraryName: v.libraryName,
              broken: !!v.broken,
            })),
            nodeSummaryByVariable: streamedSummary,
            stats: {
              totalNodes: allNodes.length,
              variableCount: streamedVariableCount,
              discoveredCount: variableIdSet.size,
              resolvedVariableCount,
              scannedNodes,
            },
          });
        }
      }
    };

    const pendingNodeLevelIds = new Set();

    for (let i = 0; i < allNodes.length; i += CHUNK_SIZE) {
      // Check for cancellation before processing each chunk
      if (scanCancelled) {
        figma.ui.postMessage({
          type: "scan-result",
          message: "Scan cancelled",
        });
        return;
      }

      const chunk = allNodes.slice(i, i + CHUNK_SIZE);

      for (const node of chunk) {
        if (!node.boundVariables && node.type !== "TEXT") {
          continue;
        }

        const nodeLevelIds = getBoundVariableIds(node);
        for (const id of nodeLevelIds) {
          nodeLevelIdSet.add(id);
          if (!variableIdSet.has(id)) pendingNodeLevelIds.add(id);
        }
        const ids = new Set(nodeLevelIds);
        const segmentIds = Array.from(getSegmentBoundVariableIds(node));
        if (segmentIds.length > 0) segmentBoundIdsByNode[node.id] = segmentIds;
        for (const id of segmentIds) ids.add(id);
        const inst = getNearestInstance(node);
        const hidden = isEffectivelyHidden(node);
        const pageName = getPageName(inst || node);

        for (const id of ids) {
          variableIdSet.add(id);
          if (!nodesByVariableMap[id]) nodesByVariableMap[id] = new Map();

          if (inst) {
            // Register the nearest instance as the representative node for
            // the usage list shown in the UI (deduplicates multiple inner
            // children of the same instance).
            const dedupKey = inst.id + "|" + id;
            if (!nodesByVariableMap[id].has(dedupKey)) {
              nodesByVariableMap[id].set(dedupKey, {
                id: inst.id,
                n: inst.name,
                t: "INSTANCE",
                p: pageName,
                h: hidden,
              });
            }
            // Track the actual child node ID separately (not sent to UI).
            // rebind uses this to load instance children into nodeById even
            // when the rebind scope doesn't include the instance root.
            if (!instanceChildNodeIds[node.id]) {
              instanceChildNodeIds[node.id] = true;
            }
          } else if (!nodesByVariableMap[id].has(node.id)) {
            nodesByVariableMap[id].set(node.id, {
              id: node.id,
              n: node.name,
              t: node.type,
              p: pageName,
              h: hidden,
            });
          }
        }
      }

      const scannedNodes = Math.min(i + CHUNK_SIZE, allNodes.length);
      const now = Date.now();
      if (pendingNodeLevelIds.size > 0) {
        await resolveVariableIds(pendingNodeLevelIds, scannedNodes);
        pendingNodeLevelIds.clear();
      }
      if (now - lastProgressAt > PROGRESS_INTERVAL) {
        const pct = 20 + Math.round((scannedNodes / allNodes.length) * 40);
        figma.ui.postMessage({
          type: "scan-progress",
          message: `Scanned ${scannedNodes} / ${allNodes.length} nodes…`,
          pct: Math.min(pct, 60),
          scannedNodes,
          totalNodes: allNodes.length,
        });
        lastProgressAt = now;
        await yieldTick();
      }
    }

    if (pendingNodeLevelIds.size > 0) {
      await resolveVariableIds(pendingNodeLevelIds, allNodes.length);
      pendingNodeLevelIds.clear();
    }

    // Check for cancellation after main loop
    if (scanCancelled) {
      figma.ui.postMessage({
        type: "scan-result",
        message: "Scan cancelled",
      });
      return;
    }

    if (variableIdSet.size === 0) {
      lastScanNodesByVariable = {};
      lastScanInstanceChildNodeIds = {};
      lastScanLookupMaps = null;
      figma.ui.postMessage({
        type: "scan-result",
        variables: [],
        message: "No bound variables found in this scope.",
      });
      return;
    }

// ── Step 5: Resolve variable IDs → metadata ──────────────────────────────
    figma.ui.postMessage({
      type: "scan-progress",
      message: "Resolving variables…",
      pct: 60,
      scannedNodes: 0,
      totalNodes: allNodes.length,
    });

    // Check for cancellation before Step 5
    if (scanCancelled) {
      figma.ui.postMessage({
        type: "scan-result",
        message: "Scan cancelled",
      });
      return;
    }

    figma.ui.postMessage({
      type: "scan-progress",
      message: "Building variable list…",
      pct: 84,
      scannedNodes: allNodes.length,
      totalNodes: allNodes.length,
    });

    const unresolvedIds = Array.from(variableIdSet).filter(
      (id) => !resolvedVariableIds.has(id),
    );
    await resolveVariableIds(unresolvedIds, allNodes.length);

    figma.ui.postMessage({
      type: "scan-progress",
      message: `Scanning… ${streamedVariableCount} variable${streamedVariableCount !== 1 ? "s" : ""} found`,
      pct: 84,
      scannedNodes: allNodes.length,
      totalNodes: allNodes.length,
    });

    const uiVariableInfo = finalVariableInfo.map((v) => ({
      id: v.id,
      name: v.name,
      key: v.key,
      resolvedType: v.resolvedType,
      collectionId: v.collectionId,
      collectionName: v.collectionName,
      libraryName: v.libraryName,
      broken: !!v.broken,
    }));

    // ── Step 9: Build ID/key/name lookup maps ─────────────────────────────────
    figma.ui.postMessage({
      type: "scan-progress",
      message: "Building lookup maps…",
      pct: 90,
    });

    const boundIdToKey = {};
    const boundIdToName = {};
    const boundIdToCollectionKey = {};
    const variableKeyToCollectionKey = {};

    const collectionIdToKey = {};
    for (const c of remoteCollections) {
      collectionIdToKey["VariableCollectionId:" + c.key] = c.key;
    }
    for (const c of localCollections) {
      if (c.localId) collectionIdToKey[c.localId] = c.key;
    }

    for (const v of finalVariableInfo) {
      if (v.broken) continue;
      if (v.id && v.key) boundIdToKey[v.id] = v.key;
      if (v.id && v.name) boundIdToName[v.id] = v.name;
      if (v._queriedId && v._queriedId !== v.id) {
        if (v.key) boundIdToKey[v._queriedId] = v.key;
        if (v.name) boundIdToName[v._queriedId] = v.name;
      }
      const collKey = v.collectionId ? collectionIdToKey[v.collectionId] : null;
      if (v.id && collKey) boundIdToCollectionKey[v.id] = collKey;
      if (v._queriedId && collKey)
        boundIdToCollectionKey[v._queriedId] = collKey;
      if (v.key && collKey) variableKeyToCollectionKey[v.key] = collKey;
    }

    // Register remapped (segment-alias) IDs so rebind can resolve them.
    // e.g. segment ID d12d214e3e2 → canonical ID 6f022024567 (both = Neutral 900)
    for (const [segId, canonicalId] of Object.entries(idRemap)) {
      if (boundIdToKey[canonicalId])
        boundIdToKey[segId] = boundIdToKey[canonicalId];
      if (boundIdToName[canonicalId])
        boundIdToName[segId] = boundIdToName[canonicalId];
      if (boundIdToCollectionKey[canonicalId])
        boundIdToCollectionKey[segId] = boundIdToCollectionKey[canonicalId];
    }

    // Resolve segment-level alias IDs not already in the map.
    // These are IDs from paint.boundVariables.color.id inside getStyledTextSegments —
    // they may differ from the IDs returned by getVariableByIdAsync (cross-file aliases).
    // We must register BOTH the queried ID and the resolved ID in all lookup maps.
    const segmentAliasIds = new Set();
    for (const segmentIds of Object.values(segmentBoundIdsByNode)) {
      for (const id of segmentIds) {
        if (!boundIdToName[id]) segmentAliasIds.add(id);
      }
    }
    if (segmentAliasIds.size > 0) {
      await pMap(
        Array.from(segmentAliasIds),
        async (queriedId) => {
          const v = await getCachedVariable(queriedId);
          if (v) {
            // Register under the queried ID (what segments report)
            boundIdToKey[queriedId] = v.key;
            boundIdToName[queriedId] = v.name;
            const collKey = v.variableCollectionId
              ? collectionIdToKey[v.variableCollectionId]
              : null;
            if (collKey) {
              boundIdToCollectionKey[queriedId] = collKey;
              variableKeyToCollectionKey[v.key] = collKey;
            }
            // Also register under the resolved ID (what getVariableByIdAsync returns)
            // in case Figma uses a different ID at rebind time
            if (v.id !== queriedId) {
              boundIdToKey[v.id] = v.key;
              boundIdToName[v.id] = v.name;
              if (collKey) boundIdToCollectionKey[v.id] = collKey;
            }
          }
        },
        LOAD_CONCURRENCY,
      );
    }

    // ── Step 10: Summary stats ────────────────────────────────────────────────
    const nodesByVariable = {};
    const nodeSummaryByVariable = {};
    let hiddenLayerCount = 0;
    for (const [varId, map] of Object.entries(nodesByVariableMap)) {
      const entries = Array.from(map.values());
      nodesByVariable[varId] = entries;
      let hasInstances = false;
      for (const entry of entries) {
        if (entry.h) hiddenLayerCount += 1;
        if (entry.t === "INSTANCE") hasInstances = true;
      }
      nodeSummaryByVariable[varId] = {
        c: entries.length,
        h: entries.filter((entry) => entry.h).length,
        i: hasInstances,
      };
    }
    lastScanNodesByVariable = nodesByVariable;
    lastScanInstanceChildNodeIds = instanceChildNodeIds;
    lastScanLookupMaps = {
      boundIdToKey,
      boundIdToName,
      boundIdToCollectionKey,
      variableKeyToCollectionKey,
      idRemap,
    };

    const brokenCount = finalVariableInfo.filter((v) => v.broken).length;

    figma.ui.postMessage({
      type: "scan-progress",
      message: "Done.",
      pct: 100,
      scannedNodes: allNodes.length,
      totalNodes: allNodes.length,
    });
    setRelaunchForRoots(scope, roots);

    figma.ui.postMessage({
      type: "scan-complete",
      variables: uiVariableInfo,
      libraryCollections: remoteCollections.concat(localCollections),
      nodeSummaryByVariable,
      boundIdToKey,
      boundIdToName,
      boundIdToCollectionKey,
      variableKeyToCollectionKey,
      idRemap,
      stats: {
        totalNodes: allNodes.length,
        hiddenLayerCount,
        brokenCount,
        variableCount: uiVariableInfo.length,
        scannedNodes: allNodes.length,
      },
    });
  } catch (err) {
    lastScanNodesByVariable = {};
    lastScanInstanceChildNodeIds = {};
    lastScanLookupMaps = null;
    figma.ui.postMessage({ type: "scan-result", error: String(err) });
  }
}

// ─── Get variable usage nodes ─────────────────────────────────────────────────

async function handleGetVariableNodes({ variableId }) {
  try {
    figma.ui.postMessage({
      type: "variable-nodes-result",
      variableId,
      nodes: lastScanNodesByVariable[variableId] || [],
    });
  } catch (err) {
    figma.ui.postMessage({
      type: "variable-nodes-result",
      variableId,
      error: String(err),
    });
  }
}

// ─── Get library variables ────────────────────────────────────────────────────

async function handleGetLibraryVariables({ collectionKey, isLocal, localId }) {
  try {
    let variables = [];

    if (isLocal) {
      const allLocal = await figma.variables.getLocalVariablesAsync();
      const filtered = allLocal.filter(
        (v) => v.variableCollectionId === localId,
      );
      variables = filtered.map((v) => ({
        key: v.key,
        name: v.name,
        resolvedType: v.resolvedType,
        isLocal: true,
        localId: v.id,
      }));
    } else {
      const raw =
        await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
          collectionKey,
        );
      variables = raw.map((v) => ({
        key: v.key,
        name: v.name,
        resolvedType: v.resolvedType,
        isLocal: false,
      }));
    }

    figma.ui.postMessage({
      type: "library-variables-result",
      collectionKey,
      variables,
    });
  } catch (err) {
    figma.ui.postMessage({
      type: "library-variables-result",
      collectionKey,
      error: String(err),
    });
  }
}

// ─── Rebind ───────────────────────────────────────────────────────────────────

async function handleRebind({
  mappings,
  nodeMappings,
  scope,
  dryRun,
  includeHidden,
  boundIdToKey,
  boundIdToName,
  boundIdToCollectionKey,
  variableKeyToCollectionKey,
  idRemap,
}) {
  try {
    const lookupMaps = lastScanLookupMaps || {};
    boundIdToKey = boundIdToKey || lookupMaps.boundIdToKey || {};
    boundIdToName = boundIdToName || lookupMaps.boundIdToName || {};
    boundIdToCollectionKey =
      boundIdToCollectionKey || lookupMaps.boundIdToCollectionKey || {};
    variableKeyToCollectionKey =
      variableKeyToCollectionKey || lookupMaps.variableKeyToCollectionKey || {};
    idRemap = idRemap || lookupMaps.idRemap || {};

    figma.ui.postMessage({
      type: "rebind-progress",
      message: "Loading scope…",
      pct: 0,
    });

    const roots = (await getRoots(scope, cachedSelectionIds)) || [];
    const nodesToProcess = collectNodesForRebind(roots, includeHidden);
    const nodeById = {};
    for (const node of nodesToProcess) {
      nodeById[node.id] = node;
    }

    // Supplement nodeById with any instance-child nodes recorded during scan
    // that are not already in scope. This handles the case where the user
    // chose "Selection" scope and the selected root is an override layer inside
    // an instance — the instance itself won't be in nodesToProcess, but its
    // children (the actual override nodes) must be reachable by
    // applyOverrideToDescendants so variable mappings are applied correctly.
    const instanceChildIds = Object.keys(lastScanInstanceChildNodeIds);
    if (instanceChildIds.length > 0) {
      const missingChildIds = instanceChildIds.filter((id) => !nodeById[id]);
      if (missingChildIds.length > 0) {
        await pMap(
          missingChildIds,
          async (id) => {
            try {
              const node = await figma.getNodeByIdAsync(id);
              if (node) {
                if (typeof node.loadAsync === "function")
                  await node.loadAsync();
                nodeById[id] = node;
                nodesToProcess.push(node);
              }
            } catch (err) {
              debugWarn("rebind: could not resolve instance child node:", err);
            }
          },
          LOAD_CONCURRENCY,
        );
      }
    }

    figma.ui.postMessage({
      type: "rebind-progress",
      message: `Loading ${nodesToProcess.length} nodes…`,
      pct: 5,
    });

    // Load all nodes before reading their properties.
    // This is especially important for nodes inside instances — Figma returns
    // figma.mixed for paint properties on unloaded instance children even when
    // they have a perfectly normal fill array once loaded.
    await pMap(
      nodesToProcess,
      async (node) => {
        try {
          if (typeof node.loadAsync === "function") await node.loadAsync();
        } catch (err) {
          debugWarn("rebind loadAsync failed:", err);
        }
      },
      LOAD_CONCURRENCY,
    );

    // ── Resolve target variables ──────────────────────────────────────────────
    figma.ui.postMessage({
      type: "rebind-progress",
      message: "Importing target variables…",
      pct: 15,
    });

    const errors = [];
    const errorCounts = new Map();
    const MAX_DISTINCT_ERRORS = 200;
    const variableErrorsById = {};
    const updatedVariableIds = new Set();

    const addVariableError = (variableId, message) => {
      if (!variableId || !message) return;
      const canonicalId = getCanonicalVariableId(variableId, idRemap);
      if (!canonicalId) return;
      if (!variableErrorsById[canonicalId]) {
        variableErrorsById[canonicalId] = [];
      }
      if (!variableErrorsById[canonicalId].includes(message)) {
        variableErrorsById[canonicalId].push(message);
      }
    };

    const recordError = (message) => {
      if (!message) return;
      const nextCount = (errorCounts.get(message) || 0) + 1;
      if (
        !errorCounts.has(message) &&
        errorCounts.size >= MAX_DISTINCT_ERRORS
      ) {
        const overflowMessage =
          "Additional warnings suppressed to keep results manageable.";
        if (!errorCounts.has(overflowMessage)) {
          errorCounts.set(overflowMessage, 1);
          errors.push(overflowMessage);
        }
        return;
      }
      errorCounts.set(message, nextCount);
      if (nextCount === 1) errors.push(message);
    };

    const recordVariableError = (variableId, message) => {
      recordError(message);
      addVariableError(variableId, message);
    };

    // Build deduplicated toKey → { isLocal, localId } map
    const keyMeta = {};
    const targetKeyToSourceIds = {};
    const registerTargetSource = (toKey, sourceId) => {
      if (!toKey || !sourceId) return;
      const canonicalId = getCanonicalVariableId(sourceId, idRemap);
      if (!canonicalId) return;
      if (!targetKeyToSourceIds[toKey]) targetKeyToSourceIds[toKey] = new Set();
      targetKeyToSourceIds[toKey].add(canonicalId);
    };
    for (const { toKey, isLocal, localId } of mappings || []) {
      if (!toKey) continue;
      if (!keyMeta[toKey] || isLocal)
        keyMeta[toKey] = { isLocal: !!isLocal, localId };
    }
    for (const mapping of mappings || []) {
      registerTargetSource(mapping.toKey, mapping.fromId);
    }
    for (const mapping of Object.values(nodeMappings || {})) {
      const { toKey, isLocal, localId } = mapping;
      if (!toKey) continue;
      if (!keyMeta[toKey] || isLocal)
        keyMeta[toKey] = { isLocal: !!isLocal, localId };
      registerTargetSource(toKey, mapping.fromVariableId);
    }

    const keyToVariable = {};
    await pMap(
      Object.entries(keyMeta),
      async ([toKey, { isLocal, localId }]) => {
        try {
          if (isLocal) {
            const v = await getCachedVariable(localId);
            if (v) keyToVariable[toKey] = v;
          } else {
            keyToVariable[toKey] =
              await figma.variables.importVariableByKeyAsync(toKey);
          }
        } catch (e) {
          const message = `Could not resolve variable key "${toKey}": ${e}`;
          recordError(message);
          for (const sourceId of Array.from(
            targetKeyToSourceIds[toKey] || [],
          )) {
            addVariableError(sourceId, message);
          }
        }
      },
      LOAD_CONCURRENCY,
    );

    // ── Build matching lookup maps ────────────────────────────────────────────

    const idToTarget = {};
    const keyToTarget = {};
    const nameToTarget = {};

    for (const { fromId, fromKey, toKey } of mappings || []) {
      if (toKey && keyToVariable[toKey]) {
        const tgt = keyToVariable[toKey];
        if (fromId) idToTarget[fromId] = tgt;
        if (fromKey) keyToTarget[fromKey] = tgt;
        const varName = (boundIdToName || {})[fromId];
        if (varName) nameToTarget[varName] = tgt;
      }
    }

    // ── Node-level overrides ──────────────────────────────────────────────────
    // nodeId → [{ sourceCollectionKey, sourceVariableKey, targetVariable }]
    const nodeOverrides = {};

    const applyOverride = (
      nodeId,
      sourceVariableKey,
      sourceCollectionKey,
      targetVar,
    ) => {
      // Use composite key to allow multiple variable mappings on the same node
      const overrideKey = nodeId + "|" + sourceVariableKey;
      if (!nodeOverrides[overrideKey]) nodeOverrides[overrideKey] = [];
      nodeOverrides[overrideKey].push({
        sourceCollectionKey,
        sourceVariableKey,
        targetVariable: targetVar,
      });
    };

    const applyOverrideToDescendants = (
      node,
      overrideKey,
      targetVar,
    ) => {
      if (!node || !("children" in node)) return;
      const stack = [];
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
      while (stack.length > 0) {
        const current = stack.pop();
        if (nodeById[current.id]) {
          if (!nodeOverrides[overrideKey]) nodeOverrides[overrideKey] = [];
          nodeOverrides[overrideKey].push({
            targetVariable: targetVar,
          });
        }
        if ("children" in current) {
          for (let i = current.children.length - 1; i >= 0; i--) {
            stack.push(current.children[i]);
          }
        }
      }
    };

    await pMap(
      Object.entries(nodeMappings || {}),
      async ([
        key,
        { nodeId, sourceCollectionKey, fromVariableKey, toKey },
      ]) => {
        if (!toKey || !keyToVariable[toKey]) {
          debugWarn("nodeMappings: missing toKey or targetVar for key", key);
          return;
        }
        const targetVar = keyToVariable[toKey];
        if (!targetVar) {
          debugWarn(
            "nodeMappings: could not resolve targetVar for toKey",
            toKey,
          );
          return;
        }

        // Apply to the representative node itself
        applyOverride(nodeId, fromVariableKey, sourceCollectionKey, targetVar);

        // Also apply to all descendants that are in nodesToProcess
        // This handles cases where user maps a parent node but the variable is on a child
        let representativeNode = nodeById[nodeId];
        if (!representativeNode) {
          try {
            const resolved = await figma.getNodeByIdAsync(nodeId);
            if (resolved) {
              if (typeof resolved.loadAsync === "function") {
                await resolved.loadAsync();
              }
              representativeNode = resolved;
            }
          } catch (err) {
            debugWarn(
              "nodeMappings: could not resolve representative node:",
              err,
            );
          }
        }

        if (representativeNode) {
          applyOverrideToDescendants(
            representativeNode,
            nodeId + "|" + fromVariableKey,
            targetVar,
          );
        }
      },
      LOAD_CONCURRENCY,
    );

    // ── Build stable varId→key cache ──────────────────────────────────────────
    // Primary source: scan-provided map (remote IDs can't be re-resolved fresh)
    const varIdToKeyCache = Object.assign({}, boundIdToKey || {});
    const keyToBoundName = {};
    const canonicalIdCache = {};
    const keyToCollectionKeyMap = Object.assign(
      {},
      variableKeyToCollectionKey || {},
    );

    for (const { fromId, fromKey, fromCollectionKey } of mappings || []) {
      if (fromId && fromKey && !varIdToKeyCache[fromId])
        varIdToKeyCache[fromId] = fromKey;
      if (fromKey && fromCollectionKey)
        keyToCollectionKeyMap[fromKey] = fromCollectionKey;
    }
    for (const {
      fromVariableId,
      fromVariableKey,
      sourceCollectionKey,
    } of Object.values(nodeMappings || {})) {
      if (
        fromVariableId &&
        fromVariableKey &&
        !varIdToKeyCache[fromVariableId]
      ) {
        varIdToKeyCache[fromVariableId] = fromVariableKey;
      }
      if (fromVariableKey && sourceCollectionKey)
        keyToCollectionKeyMap[fromVariableKey] = sourceCollectionKey;
    }
    for (const [boundId, boundKey] of Object.entries(boundIdToKey || {})) {
      const boundName = (boundIdToName || {})[boundId];
      if (boundKey && boundName && !keyToBoundName[boundKey]) {
        keyToBoundName[boundKey] = boundName;
      }
    }

    const textFillSegmentsCache = {};
    const getCachedTextFillSegments = (node) => {
      if (!node || node.type !== "TEXT") return null;
      if (textFillSegmentsCache[node.id] !== undefined) {
        return textFillSegmentsCache[node.id];
      }
      try {
        textFillSegmentsCache[node.id] = node.getStyledTextSegments(["fills"]);
      } catch (err) {
        debugWarn("getCachedTextFillSegments failed:", err);
        textFillSegmentsCache[node.id] = null;
      }
      return textFillSegmentsCache[node.id];
    };

    // Last-resort: try to resolve still-unknown variable IDs.
    // We must check BOTH node.boundVariables AND per-segment paint bindings on
    // TEXT nodes, because segment-only variables (e.g. a hyperlink colour on a
    // specific character range) don't appear in node.boundVariables when fills
    // is figma.mixed — they are invisible to the standard property walk.
    const unknownIds = new Set();

    const getCachedCanonicalId = (value) => {
      if (!value) return value;
      if (canonicalIdCache[value] !== undefined) return canonicalIdCache[value];
      const canonical = getCanonicalVariableId(value, idRemap);
      canonicalIdCache[value] = canonical;
      return canonical;
    };

    const getBoundVariableName = (value, fallbackKey) => {
      if (value && (boundIdToName || {})[value]) return boundIdToName[value];
      if (fallbackKey && keyToBoundName[fallbackKey])
        return keyToBoundName[fallbackKey];
      return null;
    };

    const matchesPaintBinding = (
      paintId,
      canonicalPaintId,
      sourceCanonicalId,
      sourceRawId,
      sourceName,
      sourceKey,
    ) => {
      if (canonicalPaintId === sourceCanonicalId || paintId === sourceRawId) {
        return true;
      }
      if (
        sourceKey &&
        canonicalPaintId &&
        varIdToKeyCache[canonicalPaintId] === sourceKey
      ) {
        return true;
      }
      const paintName = getBoundVariableName(
        canonicalPaintId || paintId,
        canonicalPaintId ? varIdToKeyCache[canonicalPaintId] : null,
      );
      return !!(paintName && sourceName && paintName === sourceName);
    };

    // ── Process nodes ─────────────────────────────────────────────────────────
    figma.ui.postMessage({
      type: "rebind-progress",
      message: "Applying remappings…",
      pct: 30,
    });

    let reboundCount = 0;
    let nodeCount = 0;
    let skippedCount = 0;
    let lastProgressAt = Date.now();

    for (let ni = 0; ni < nodesToProcess.length; ni++) {
      const node = nodesToProcess[ni];
      const textFillSegments = getCachedTextFillSegments(node);
      const entries = getBoundVariableEntries(node, textFillSegments);
      let nodeChanged = false;

      for (const entry of entries) {
        if (entry.id && varIdToKeyCache[entry.id] === undefined) {
          unknownIds.add(entry.id);
        }

        const { field, index, segmentRange } = entry;
        // Normalise segment alias IDs to their canonical counterparts.
        // Figma returns different internal IDs for the same variable when accessed
        // via node.boundVariables vs getStyledTextSegments — idRemap unifies them.
        const rawId = entry.id;
        const id = getCachedCanonicalId(rawId);
        const varKey = varIdToKeyCache[id] || null;
        const boundCollKey =
          (varKey && keyToCollectionKeyMap[varKey]) ||
          (boundIdToCollectionKey || {})[id] ||
          null;

        // Node-level override lookup using composite key: nodeId|variableKey
        const nodeOverrideList = nodeOverrides[node.id + "|" + varKey] || [];

        let nodeOverrideTarget = null;
        for (const ov of nodeOverrideList) {
          if (!ov.sourceVariableKey) continue; // Skip if no source variable key
          const collectionMatch =
            !ov.sourceCollectionKey || ov.sourceCollectionKey === boundCollKey;
          const variableMatch = ov.sourceVariableKey === varKey;
          if (collectionMatch && variableMatch) {
            nodeOverrideTarget = ov.targetVariable;
            break;
          }
        }

        // Variable-level matching only applies if NO node-level override exists
        const boundVarName = getBoundVariableName(id, varKey);
        const varLevelTarget = !nodeOverrideTarget
          ? (varKey && keyToTarget[varKey]) ||
            idToTarget[id] ||
            (boundVarName && nameToTarget[boundVarName])
          : null;

        const targetVariable = nodeOverrideTarget || varLevelTarget;
        if (!targetVariable) {
          skippedCount++;
          continue;
        }

        if (!dryRun) {
          try {
            if (PAINT_FIELDS.has(field)) {
              // Per-segment TEXT paint rebinding
              if (segmentRange) {
                const { start, end } = segmentRange;
                // Segment entries are only produced for 'fills' (getStyledTextSegments
                // does not support 'strokes'). Guard defensively.
                if (field !== "fills") {
                  recordVariableError(
                    id || rawId,
                    'Node "' +
                      node.name +
                      '": unexpected segment entry for field=' +
                      field +
                      ", skipped",
                  );
                  continue;
                }
                const allSegs = textFillSegments || [];
                const paintIdx = index !== null ? index : 0;
                let segApplied = false;
                for (const seg of allSegs) {
                  // Overlap: seg covers any part of [start, end)
                  if (seg.end <= start || seg.start >= end) continue;
                  if (!Array.isArray(seg[field]) || !seg[field][paintIdx])
                    continue;
                  const paint = seg[field][paintIdx];
                  const paintBv =
                    paint.boundVariables && paint.boundVariables.color;
                  // Only rebind this segment if it actually carries the variable we're targeting
                  // (avoids clobbering other variables on adjacent segments)
                  const paintId = paintBv && paintBv.id;
                  const canonicalPaintId = getCachedCanonicalId(paintId);
                  const isMatch = matchesPaintBinding(
                    paintId,
                    canonicalPaintId,
                    id,
                    rawId,
                    boundVarName,
                    varKey,
                  );
                  if (!isMatch) continue;
                  const newPaints = JSON.parse(JSON.stringify(seg[field]));
                  newPaints[paintIdx] =
                    figma.variables.setBoundVariableForPaint(
                      newPaints[paintIdx],
                      "color",
                      targetVariable,
                    );
                  if (field === "fills")
                    node.setRangeFills(seg.start, seg.end, newPaints);
                  else node.setRangeStrokes(seg.start, seg.end, newPaints);
                  segApplied = true;
                }
                if (segApplied) {
                  reboundCount++;
                  nodeChanged = true;
                  if (id || rawId) updatedVariableIds.add(id || rawId);
                } else {
                  recordVariableError(
                    id || rawId,
                    'Node "' +
                      node.name +
                      '" segment [' +
                      start +
                      "-" +
                      end +
                      "]: no matching paint found (variable may have changed range)",
                  );
                }
                continue;
              }

              const rawPaints = node[field];

              if (rawPaints === figma.mixed) {
                // figma.mixed on fills/strokes only occurs on TEXT nodes where
                // different character ranges have different paint styles.
                // getStyledTextSegments supports 'fills' only, not 'strokes'.
                if (
                  node.type === "TEXT" &&
                  field === "fills" &&
                  typeof node.getStyledTextSegments === "function"
                ) {
                  const segs = textFillSegments || [];
                  let segmentRebound = false;
                  for (const seg of segs) {
                    const segPaints = seg["fills"];
                    if (!Array.isArray(segPaints) || segPaints.length === 0)
                      continue;
                    const paintIdx = index !== null ? index : 0;
                    const paint = segPaints[paintIdx];
                    if (!paint) continue;
                    const paintBv =
                      paint.boundVariables && paint.boundVariables.color;
                    if (!paintBv || !paintBv.id) continue;
                    const canonicalPaintId = getCachedCanonicalId(paintBv.id);
                    const matches = matchesPaintBinding(
                      paintBv.id,
                      canonicalPaintId,
                      id,
                      rawId,
                      boundVarName,
                      varKey,
                    );
                    if (!matches) continue;
                    const newPaints = JSON.parse(JSON.stringify(segPaints));
                    newPaints[paintIdx] =
                      figma.variables.setBoundVariableForPaint(
                        newPaints[paintIdx],
                        "color",
                        targetVariable,
                      );
                    node.setRangeFills(seg.start, seg.end, newPaints);
                    segmentRebound = true;
                  }
                  if (segmentRebound) {
                    reboundCount++;
                    nodeChanged = true;
                    if (id || rawId) updatedVariableIds.add(id || rawId);
                  }
                  // No warning if segments were found but none matched — the
                  // variable may legitimately live in the node-level entry only.
                } else {
                  // Non-TEXT node returning figma.mixed for fills/strokes.
                  // This happens on vector/shape nodes that are children of
                  // instances — Figma returns figma.mixed for paint properties
                  // on instance children before they are individually loaded.
                  // Strategy: load the node explicitly, then re-read the paints.
                  try {
                    if (typeof node.loadAsync === "function") {
                      await node.loadAsync();
                    }
                    const paintIdx = index !== null ? index : 0;
                    const reread = node[field];

                    if (Array.isArray(reread) && reread[paintIdx]) {
                      // Successfully read the paint array after explicit load
                      const paints = JSON.parse(JSON.stringify(reread));
                      paints[paintIdx] =
                        figma.variables.setBoundVariableForPaint(
                          paints[paintIdx],
                          "color",
                          targetVariable,
                        );
                      node[field] = paints;
                      reboundCount++;
                      nodeChanged = true;
                      if (id || rawId) updatedVariableIds.add(id || rawId);
                    } else if (reread === figma.mixed) {
                      // Still mixed after explicit load — node is an instance
                      // child whose paints can't be read directly. This binding
                      // will need to be remapped via the main component instead.
                      recordVariableError(
                        id || rawId,
                        'Node "' +
                          node.name +
                          '" (' +
                          node.type +
                          ') field "' +
                          field +
                          "[" +
                          paintIdx +
                          ']": instance child — remap the main component instead',
                      );
                    }
                  } catch (e) {
                    recordVariableError(
                      id || rawId,
                      'Node "' +
                        node.name +
                        '" field "' +
                        field +
                        '": ' +
                        String(e),
                    );
                  }
                }
                continue;
              }

              if (!Array.isArray(rawPaints)) continue;
              const paintIndex = index !== null ? index : 0;
              if (!rawPaints[paintIndex]) continue;
              // JSON clone forces Figma to rehydrate the paint array on hidden/instance nodes
              const paints = JSON.parse(JSON.stringify(rawPaints));
              paints[paintIndex] = figma.variables.setBoundVariableForPaint(
                paints[paintIndex],
                "color",
                targetVariable,
              );
              node[field] = paints;
            } else {
              // Check whether this node is a child of an instance before
              // calling setBoundVariable. Figma silently ignores the call
              // (no error thrown, no change applied) when:
              //   • the node is inside an instance AND
              //   • the field has no explicit instance override set
              // Detect this by comparing the bound variable ID before and after.
              let isInstanceChild = false;
              let parentCursor = node.parent;
              while (
                parentCursor &&
                parentCursor.type !== "PAGE" &&
                parentCursor.type !== "DOCUMENT"
              ) {
                if (parentCursor.type === "INSTANCE") {
                  isInstanceChild = true;
                  break;
                }
                parentCursor = parentCursor.parent;
              }

              const bvBefore =
                node.boundVariables &&
                node.boundVariables[field] !== figma.mixed
                  ? node.boundVariables[field]
                  : null;
              const idBefore =
                bvBefore && bvBefore.type === "VARIABLE_ALIAS"
                  ? bvBefore.id
                  : null;

              node.setBoundVariable(field, targetVariable);

              // Re-read after the call to check whether Figma actually applied it
              const bvAfter =
                node.boundVariables &&
                node.boundVariables[field] !== figma.mixed
                  ? node.boundVariables[field]
                  : null;
              const idAfter =
                bvAfter && bvAfter.type === "VARIABLE_ALIAS"
                  ? bvAfter.id
                  : null;

              const appliedSuccessfully =
                idAfter === targetVariable.id ||
                // Also count as success if the ID changed at all (library alias mismatch)
                (idBefore !== idAfter && idAfter !== null);

              if (!appliedSuccessfully && isInstanceChild) {
                recordVariableError(
                  id || rawId,
                  `Node "${node.name}" (${node.type}) field "${field}": ` +
                    `instance override not applied — this property has no override ` +
                    `set on the instance. Enable an override on this property first, ` +
                    `or remap the main component instead.`,
                );
                continue;
              }
            }
            reboundCount++;
            nodeChanged = true;
            if (id || rawId) updatedVariableIds.add(id || rawId);
          } catch (e) {
            recordVariableError(
              id || rawId,
              `Node "${node.name}" field "${field}": ${e}`,
            );
          }
        } else {
          // Dry run — count only
          reboundCount++;
          nodeChanged = true;
        }
      }

      if (nodeChanged) nodeCount++;

      // Progress update
      const now = Date.now();
      if (now - lastProgressAt > PROGRESS_INTERVAL) {
        const pct = 30 + Math.round((ni / nodesToProcess.length) * 65);
        figma.ui.postMessage({
          type: "rebind-progress",
          message: `Processing node ${ni + 1} / ${nodesToProcess.length}…`,
          pct: Math.min(pct, 95),
        });
        lastProgressAt = now;
        await yieldTick();
      }
    }

    // Resolve any variable IDs that were encountered without a pre-existing key mapping
    if (unknownIds.size > 0) {
      await pMap(
        Array.from(unknownIds),
        async (id) => {
          const v = await getCachedVariable(id);
          varIdToKeyCache[id] = v ? v.key : null;
        },
        LOAD_CONCURRENCY,
      );
    }

    const warningSummary = Array.from(errorCounts.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));

    if (!dryRun && reboundCount > 0) {
      figma.commitUndo();
    }
    setRelaunchForRoots(scope, roots);
    figma.ui.postMessage({
      type: "rebind-result",
      reboundCount,
      nodeCount,
      skippedCount,
      updatedVariableIds: Array.from(updatedVariableIds).map((id) =>
        getCanonicalVariableId(id, idRemap),
      ),
      updatedVariableCount: Array.from(
        new Set(
          Array.from(updatedVariableIds).map((id) =>
            getCanonicalVariableId(id, idRemap),
          ),
        ),
      ).length,
      variableErrorsById,
      errors,
      warningSummary,
      dryRun,
    });
  } catch (err) {
    figma.ui.postMessage({ type: "rebind-result", error: String(err) });
  }
}

// ─── Select nodes in canvas ───────────────────────────────────────────────────

async function handleSelectNodes({ nodeIds }) {
  try {
    if (nodeIds.length === 0) return;

    const resolveNodeIds = async (ids) => {
      const found = [];
      await pMap(
        ids,
        async (id) => {
          try {
            const node = await figma.getNodeByIdAsync(id);
            if (node) found.push(node);
          } catch (err) {
            debugWarn("handleSelectNodes could not resolve node:", err);
          }
        },
        LOAD_CONCURRENCY,
      );
      return found;
    };

    let resolved = await resolveNodeIds(nodeIds);

    // If any IDs failed, load all pages and retry missing ones
    if (resolved.length < nodeIds.length) {
      await figma.loadAllPagesAsync();
      const resolvedIds = new Set(resolved.map((n) => n.id));
      const missingIds = nodeIds.filter((id) => !resolvedIds.has(id));
      const retried = await resolveNodeIds(missingIds);
      if (retried.length > 0) resolved = resolved.concat(retried);
    }

    const uniqueResolved = [];
    const seenNodeIds = new Set();
    resolved.forEach((node) => {
      if (!seenNodeIds.has(node.id)) {
        seenNodeIds.add(node.id);
        uniqueResolved.push(node);
      }
    });
    resolved = uniqueResolved;

    if (resolved.length === 0) {
      figma.notify("Could not find nodes.", { error: true });
      return;
    }

    // Switch to the page of the first resolved node
    let page = resolved[0].parent;
    while (page && page.type !== "PAGE") page = page.parent;
    if (page && page.type === "PAGE") await figma.setCurrentPageAsync(page);

    const onPage = resolved.filter((n) => {
      let cur = n;
      while (cur && cur.type !== "PAGE") cur = cur.parent;
      return cur && cur === figma.currentPage;
    });

    figma.currentPage.selection = onPage;
    if (onPage.length > 0) figma.viewport.scrollAndZoomIntoView(onPage);

    const skipped = resolved.length - onPage.length;
    figma.notify(
      `Selected ${onPage.length} node${onPage.length !== 1 ? "s" : ""}` +
        (skipped > 0 ? ` (${skipped} on other pages skipped)` : "") +
        ".",
    );
  } catch (err) {
    figma.notify("Select error: " + String(err), { error: true });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "load-preferences":
      figma.ui.postMessage({
        type: "preferences-loaded",
        preferences: await getUIPreferences(),
      });
      break;
    case "save-preferences":
      await saveUIPreferences(msg.preferences || {});
      break;
    case "scan":
      await handleScan(msg);
      break;
    case "cancel-scan":
      handleCancelScan();
      break;
    case "get-library-variables":
      await handleGetLibraryVariables(msg);
      break;
    case "get-variable-nodes":
      await handleGetVariableNodes(msg);
      break;
    case "rebind":
      await handleRebind(msg);
      break;
    case "select-nodes":
      await handleSelectNodes(msg);
      break;
    case "resize":
      figma.ui.resize(msg.width, msg.height);
      break;
    case "close":
      figma.closePlugin();
      break;
    default:
      console.warn("Unknown message type:", msg.type);
  }
};
