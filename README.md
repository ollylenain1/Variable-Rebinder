# Blueprint: Variable Rebinder — Figma Plugin

A Figma plugin that scans your design for bound variables and lets you remap them to the correct library. Useful when:

- You've duplicated a file and variables are pointing to the wrong library
- You're migrating from one design system to another
- You need to swap local variables for shared library variables
- Variables got unlinked after a library rename or reorganisation

---

## Files

```
blueprint-variable-rebinder/
├── manifest.json   ← plugin manifest
├── code.js         ← main plugin logic (Figma API side)
├── ui.html         ← plugin UI (HTML/CSS/JS)
└── README.md
```

---

## Installation (Development)

1. Open **Figma Desktop**
2. Go to **Menu → Plugins → Development → Import plugin from manifest…**
3. Select the `manifest.json` file from this folder
4. The plugin will appear under **Plugins → Development → Blueprint: Variable Rebinder**

---

## How to Use

### 1. Choose your scope

Select from **Selection**, **Current Page**, or **Whole File** at the top of the plugin.

### 2. Scan

Click **Scan** to discover all bound variables in scope. The plugin lists each variable with its current collection/library source.

### 3. Map variables

For each found variable, expand its card and:

- Choose the **target library collection** from the dropdown
- Choose the **target variable** within that collection (filtered to matching type)

Green dot = mapped ✓

### 4. Apply

Click **Apply Remapping**. Use the **Dry Run** toggle to preview what would change without committing.

---

## Technical Notes

- Uses `figma.variables.importVariableByKeyAsync` to import library variables before binding
- Uses `figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync` to list all connected libraries
- Uses `setBoundVariable` on each matching node
- Handles all bindable fields: fills, strokes, opacity, corner radius, width/height, text properties, etc.
- Works with COLOR, FLOAT, STRING, and BOOLEAN variable types

---

## Limitations

- Requires a Figma account with access to the target libraries
- Library variables must be in connected (shared) libraries visible in the file
- Text range variables (`setRangeBoundVariable`) require the full node to be re-bound
