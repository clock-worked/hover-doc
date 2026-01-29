# HoverDoc

HoverDoc shows hover tooltips for custom documentation comment blocks (e.g., `Class:`, `Method:`, `Description:`). It is designed for projects that do not use XML doc comments.

## Features
- Parses custom block or line comment formats.
- Matches the nearest preceding comment block to the hovered symbol.
- Supports configurable field labels and output template.

## Usage
Add a block comment above a class or method, then hover the symbol.

Example (C#):

```
/**************************************************************************
* Class: ExampleManager
* Description: Coordinates feature behavior across scenes. Handles
* state transitions and current selection tracking.
***************************************************************************/

/**************************************************************************
* Method: HandleSelection
* Description: On a right click, casts a ray, validates the hit, queries
* for the closest point, then loads the corresponding scene.
***************************************************************************/
```

## Settings
- `hoverDoc.languageIds`: Language IDs to enable HoverDoc for. Default: `["csharp"]`.
- `hoverDoc.enableSymbols`: Symbol kinds to provide hover for. Default: `["Class", "Method"]`.
- `hoverDoc.fileGlobs`: File glob patterns to enable HoverDoc for.
- `hoverDoc.commentStyle`: `block`, `line`, or `auto`.
- `hoverDoc.fieldLabels`: Field label names in your comment blocks.
- `hoverDoc.matchingRule`: `nearest` or `adjacent`.
- `hoverDoc.requireLabelMatch`: Require matching label in the comment block.
- `hoverDoc.maxBlankLines`: Blank lines allowed between comment and symbol when using `adjacent`.
- `hoverDoc.maxScanLines`: Max lines to scan upward (0 = unlimited).
- `hoverDoc.includeSignature`: Append symbol signature to hover.
- `hoverDoc.argsFormat`: `list`, `inline`, or `none`.
- `hoverDoc.outputTemplate`: Markdown template. Placeholders: `{kind}`, `{name}`, `{description}`, `{args}`, `{raw}`, `{signature}`.
- `hoverDoc.outputTemplateByKind`: Per-kind template overrides (`class`, `method`, `property`, `field`).

Example configuration:

```json
{
  "hoverDoc.languageIds": ["csharp", "cpp"],
  "hoverDoc.enableSymbols": ["Class", "Method", "Property"],
  "hoverDoc.fileGlobs": ["**/*.cs"],
  "hoverDoc.commentStyle": "block",
  "hoverDoc.fieldLabels": {
    "class": ["Class"],
    "method": ["Method"],
    "description": ["Description"],
    "args": ["Args", "Param"],
    "property": ["Property"],
    "field": ["Field"]
  },
  "hoverDoc.matchingRule": "nearest",
  "hoverDoc.requireLabelMatch": false,
  "hoverDoc.maxScanLines": 0,
  "hoverDoc.includeSignature": true,
  "hoverDoc.argsFormat": "list",
  "hoverDoc.outputTemplate": "**{name}**\n\n{description}\n\n{args}",
  "hoverDoc.outputTemplateByKind": {
    "method": "**{name}**\n\n{description}\n\n{args}\n\n{signature}"
  }
}
```

## Publishing
- Ensure the README contains no project-specific or personal identifiers.
- Update `package.json` fields: `publisher`, `version`, `repository`, `bugs`, and `homepage`.
- Add a `CHANGELOG.md` entry for the release.
- Package with `vsce package` and publish with `vsce publish`.
