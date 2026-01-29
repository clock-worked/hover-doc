import * as vscode from "vscode";

type CommentStyle = "block" | "line" | "auto";
type MatchingRule = "nearest" | "adjacent";
type SymbolKind = "Class" | "Method" | "Property" | "Field";
type ArgsFormat = "list" | "inline" | "none";

interface FieldLabels {
    class: string[];
    method: string[];
    description: string[];
    args: string[];
    property: string[];
    field: string[];
}

interface HoverDocConfig {
    languageIds: string[];
    enableSymbols: SymbolKind[];
    fileGlobs: string[];
    commentStyle: CommentStyle;
    fieldLabels: FieldLabels;
    matchingRule: MatchingRule;
    requireLabelMatch: boolean;
    maxBlankLines: number;
    maxScanLines: number;
    includeSignature: boolean;
    argsFormat: ArgsFormat;
    outputTemplate: string;
    outputTemplateByKind: OutputTemplateByKind;
}

interface OutputTemplateByKind {
    class?: string;
    method?: string;
    property?: string;
    field?: string;
}

interface ParsedComment {
    className?: string;
    methodName?: string;
    propertyName?: string;
    fieldName?: string;
    description: string;
    args: string[];
    raw: string;
}

interface CommentBlock {
    startLine: number;
    endLine: number;
    lines: string[];
}

interface CommentCacheEntry {
    version: number;
    lines: string[];
    blockComments: CommentBlock[];
    lineComments: CommentBlock[];
}

let hoverProviderDisposable: vscode.Disposable | undefined;
const commentCache = new Map<string, CommentCacheEntry>();

export function activate(context: vscode.ExtensionContext) {
    registerHoverProvider(context);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("hoverDoc")) {
                registerHoverProvider(context);
            }
        })
    );
}

export function deactivate() {
    if (hoverProviderDisposable) {
        hoverProviderDisposable.dispose();
        hoverProviderDisposable = undefined;
    }
}

function registerHoverProvider(context: vscode.ExtensionContext) {
    if (hoverProviderDisposable) {
        hoverProviderDisposable.dispose();
    }

    const selector = buildDocumentSelector(getConfig());

    hoverProviderDisposable = vscode.languages.registerHoverProvider(selector, {
        provideHover(document, position) {
            return provideHover(document, position);
        }
    });

    context.subscriptions.push(hoverProviderDisposable);
}

function getConfig(): HoverDocConfig {
    const config = vscode.workspace.getConfiguration("hoverDoc");
    return {
        languageIds: config.get<string[]>("languageIds", ["csharp"]),
        enableSymbols: config.get<SymbolKind[]>("enableSymbols", ["Class", "Method"]),
        fileGlobs: config.get<string[]>("fileGlobs", []),
        commentStyle: config.get<CommentStyle>("commentStyle", "block"),
        fieldLabels: config.get<FieldLabels>("fieldLabels", {
            class: ["Class"],
            method: ["Method"],
            description: ["Description"],
            args: ["Args", "Arguments", "Param", "Params"],
            property: ["Property"],
            field: ["Field"]
        }),
        matchingRule: config.get<MatchingRule>("matchingRule", "nearest"),
        requireLabelMatch: config.get<boolean>("requireLabelMatch", false),
        maxBlankLines: config.get<number>("maxBlankLines", 0),
        maxScanLines: config.get<number>("maxScanLines", 0),
        includeSignature: config.get<boolean>("includeSignature", false),
        argsFormat: config.get<ArgsFormat>("argsFormat", "list"),
        outputTemplate: config.get<string>("outputTemplate", "**{name}**\n\n{description}\n\n{args}"),
        outputTemplateByKind: config.get<OutputTemplateByKind>("outputTemplateByKind", {})
    };
}

function buildDocumentSelector(config: HoverDocConfig): vscode.DocumentSelector {
    const selectors: vscode.DocumentFilter[] = [];

    const languageIds = config.languageIds.length > 0 ? config.languageIds : ["csharp"];
    for (const language of languageIds) {
        selectors.push({ language, scheme: "file" });
        selectors.push({ language, scheme: "untitled" });
    }

    for (const pattern of config.fileGlobs) {
        selectors.push({ pattern, scheme: "file" });
    }

    return selectors;
}

async function provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
        return undefined;
    }

    const word = document.getText(wordRange);
    if (!word) {
        return undefined;
    }

    const config = getConfig();
    const target = await resolveDefinitionTarget(document, position, word);
    const targetDocument = target?.document ?? document;
    const targetLine = target?.line ?? position.line;
    const targetLineText = targetDocument.lineAt(targetLine).text;

    const symbolInfo = detectSymbolKind(targetLineText, word);
    if (!symbolInfo) {
        return undefined;
    }

    if (!config.enableSymbols.includes(symbolInfo.kind)) {
        return undefined;
    }

    const comment = findMatchingComment(targetDocument, targetLine, word, symbolInfo.kind, config);
    if (!comment) {
        return undefined;
    }

    const parsed = parseComment(comment.lines, config.fieldLabels);
    if (parsed.className && symbolInfo.kind === "Class" && !equalsIgnoreCase(parsed.className, word)) {
        return undefined;
    }
    if (parsed.methodName && symbolInfo.kind === "Method" && !equalsIgnoreCase(parsed.methodName, word)) {
        return undefined;
    }

    const signature = config.includeSignature
        ? getSignature(targetDocument, targetLine, word, symbolInfo.kind)
        : undefined;
    const hoverText = renderHover(
        parsed,
        symbolInfo.kind,
        word,
        config.outputTemplate,
        config.outputTemplateByKind,
        config.argsFormat,
        signature,
        config.includeSignature
    );
    if (!hoverText.trim()) {
        return undefined;
    }

    return new vscode.Hover(new vscode.MarkdownString(hoverText));
}

async function resolveDefinitionTarget(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolName: string
): Promise<{ document: vscode.TextDocument; line: number } | undefined> {
    try {
        const definitions = (await vscode.commands.executeCommand(
            "vscode.executeDefinitionProvider",
            document.uri,
            position
        )) as vscode.Location[] | vscode.LocationLink[] | undefined;

        if (!definitions || definitions.length === 0) {
            return undefined;
        }

        const first = definitions[0];
        const uri = "targetUri" in first ? first.targetUri : first.uri;
        const range = "targetRange" in first ? first.targetRange : first.range;

        const defDoc = await vscode.workspace.openTextDocument(uri);
        const defLine = range.start.line;

        const defLineText = defDoc.lineAt(defLine).text;
        if (defLineText.includes(symbolName)) {
            return { document: defDoc, line: defLine };
        }

        return { document: defDoc, line: defLine };
    } catch {
        return undefined;
    }
}

function detectSymbolKind(lineText: string, word: string): { kind: SymbolKind } | undefined {
    const classRegex = new RegExp(`\\b(class|struct|interface|enum|record)\\s+${escapeRegExp(word)}\\b`);
    if (classRegex.test(lineText)) {
        return { kind: "Class" };
    }

    const methodRegex = new RegExp(`\\b${escapeRegExp(word)}\\s*\\(`);
    if (methodRegex.test(lineText)) {
        return { kind: "Method" };
    }

    const propertyRegex = new RegExp(`\\b${escapeRegExp(word)}\\b`);
    if (propertyRegex.test(lineText) && /\{[^}]*\b(get|set)\b[^}]*\}/.test(lineText)) {
        return { kind: "Property" };
    }

    if (propertyRegex.test(lineText) && /;\s*$/.test(lineText)) {
        return { kind: "Field" };
    }

    return undefined;
}

function findMatchingComment(
    document: vscode.TextDocument,
    symbolLine: number,
    symbolName: string,
    kind: SymbolKind,
    config: HoverDocConfig
): CommentBlock | undefined {
    if (config.commentStyle === "line") {
        return findMatchingLineComment(document, symbolLine, symbolName, kind, config);
    }

    if (config.commentStyle === "block") {
        return findMatchingBlockComment(document, symbolLine, symbolName, kind, config);
    }

    const block = findMatchingBlockComment(document, symbolLine, symbolName, kind, config);
    if (block) {
        return block;
    }

    return findMatchingLineComment(document, symbolLine, symbolName, kind, config);
}

function findMatchingBlockComment(
    document: vscode.TextDocument,
    symbolLine: number,
    symbolName: string,
    kind: SymbolKind,
    config: HoverDocConfig
): CommentBlock | undefined {
    const { lines, blockComments } = getCachedCommentBlocks(document);
    return findMatchingCommentFromBlocks(
        lines,
        blockComments,
        symbolLine,
        symbolName,
        kind,
        config
    );
}

function findMatchingLineComment(
    document: vscode.TextDocument,
    symbolLine: number,
    symbolName: string,
    kind: SymbolKind,
    config: HoverDocConfig
): CommentBlock | undefined {
    const { lines, lineComments } = getCachedCommentBlocks(document);
    return findMatchingCommentFromBlocks(
        lines,
        lineComments,
        symbolLine,
        symbolName,
        kind,
        config
    );
}

function parseComment(lines: string[], labels: FieldLabels): ParsedComment {
    const normalizedLabels = normalizeLabels(labels);
    const descriptionLines: string[] = [];
    const args: string[] = [];
    let className: string | undefined;
    let methodName: string | undefined;
    let propertyName: string | undefined;
    let fieldName: string | undefined;
    let currentField: "description" | "args" | undefined;

    for (const rawLine of lines) {
        const cleaned = cleanCommentLine(rawLine);
        if (!cleaned && currentField !== "description") {
            continue;
        }

        const labelMatch = cleaned.match(/^([A-Za-z0-9_ ]+)\s*:\s*(.*)$/);
        if (labelMatch) {
            const label = labelMatch[1].trim().toLowerCase();
            const value = labelMatch[2].trim();

            if (normalizedLabels.class.has(label)) {
                className = value;
                currentField = undefined;
                continue;
            }

            if (normalizedLabels.method.has(label)) {
                methodName = value;
                currentField = undefined;
                continue;
            }

            if (normalizedLabels.property.has(label)) {
                propertyName = value;
                currentField = undefined;
                continue;
            }

            if (normalizedLabels.field.has(label)) {
                fieldName = value;
                currentField = undefined;
                continue;
            }

            if (normalizedLabels.description.has(label)) {
                if (value) {
                    descriptionLines.push(value);
                }
                currentField = "description";
                continue;
            }

            if (normalizedLabels.args.has(label)) {
                if (value) {
                    args.push(value);
                }
                currentField = "args";
                continue;
            }
        }

        if (currentField === "description") {
            if (cleaned) {
                descriptionLines.push(cleaned);
            }
            continue;
        }

        if (currentField === "args") {
            if (cleaned) {
                args.push(cleaned);
            }
            continue;
        }
    }

    return {
        className,
        methodName,
        propertyName,
        fieldName,
        description: descriptionLines.join("\n").trim(),
        args,
        raw: lines.map(cleanCommentLine).join("\n").trim()
    };
}

function normalizeLabels(labels: FieldLabels): {
    class: Set<string>;
    method: Set<string>;
    description: Set<string>;
    args: Set<string>;
    property: Set<string>;
    field: Set<string>;
} {
    return {
        class: new Set(labels.class.map((l) => l.toLowerCase())),
        method: new Set(labels.method.map((l) => l.toLowerCase())),
        description: new Set(labels.description.map((l) => l.toLowerCase())),
        args: new Set(labels.args.map((l) => l.toLowerCase())),
        property: new Set(labels.property.map((l) => l.toLowerCase())),
        field: new Set(labels.field.map((l) => l.toLowerCase()))
    };
}

function renderHover(
    parsed: ParsedComment,
    kind: SymbolKind,
    name: string,
    template: string,
    templateByKind: OutputTemplateByKind,
    argsFormat: ArgsFormat,
    signature: string | undefined,
    includeSignature: boolean
): string {
    const args = formatArgs(parsed.args, argsFormat);
    const selectedTemplate = selectTemplate(kind, template, templateByKind);

    const replacements: Record<string, string> = {
        kind,
        name,
        description: parsed.description || "",
        args,
        raw: parsed.raw || "",
        signature: signature ? `\`${signature}\`` : ""
    };

    let output = selectedTemplate;
    for (const key of Object.keys(replacements)) {
        output = output.replace(new RegExp(`\\{${key}\\}`, "g"), replacements[key]);
    }

    if (includeSignature && signature && !selectedTemplate.includes("{signature}")) {
        output = `${output}\n\n\`${signature}\``;
    }

    return output.replace(/\n{3,}/g, "\n\n").trim();
}

function cleanCommentLine(line: string): string {
    let cleaned = line.trim();
    cleaned = cleaned.replace(/^\/\*+/, "");
    cleaned = cleaned.replace(/\*+\/$/, "");
    cleaned = cleaned.replace(/^\*+/, "");
    cleaned = cleaned.replace(/^\/\/+/, "");
    return cleaned.trim();
}

function getCachedCommentBlocks(document: vscode.TextDocument): CommentCacheEntry {
    const key = document.uri.toString();
    const cached = commentCache.get(key);
    if (cached && cached.version === document.version) {
        return cached;
    }

    const lines = getDocumentLines(document);
    const blockComments = collectBlockComments(lines);
    const lineComments = collectLineComments(lines);

    const entry: CommentCacheEntry = {
        version: document.version,
        lines,
        blockComments,
        lineComments
    };
    commentCache.set(key, entry);
    return entry;
}

function getDocumentLines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let line = 0; line < document.lineCount; line++) {
        lines.push(document.lineAt(line).text);
    }
    return lines;
}

function collectBlockComments(lines: string[]): CommentBlock[] {
    const blocks: CommentBlock[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("/*")) {
            continue;
        }
        const startLine = i;
        let endLine = i;
        while (endLine < lines.length && !lines[endLine].includes("*/")) {
            endLine += 1;
        }
        if (endLine < lines.length) {
            blocks.push({
                startLine,
                endLine,
                lines: lines.slice(startLine, endLine + 1)
            });
            i = endLine;
        }
    }
    return blocks;
}

function collectLineComments(lines: string[]): CommentBlock[] {
    const blocks: CommentBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        if (!/^\s*\/\//.test(lines[i])) {
            i += 1;
            continue;
        }

        const startLine = i;
        let endLine = i;
        while (endLine + 1 < lines.length && /^\s*\/\//.test(lines[endLine + 1])) {
            endLine += 1;
        }

        blocks.push({
            startLine,
            endLine,
            lines: lines.slice(startLine, endLine + 1)
        });
        i = endLine + 1;
    }
    return blocks;
}

function findMatchingCommentFromBlocks(
    lines: string[],
    blocks: CommentBlock[],
    symbolLine: number,
    symbolName: string,
    kind: SymbolKind,
    config: HoverDocConfig
): CommentBlock | undefined {
    const scanLimit = config.maxScanLines > 0 ? symbolLine - config.maxScanLines : 0;

    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.endLine >= symbolLine) {
            continue;
        }

        if (block.endLine < scanLimit) {
            break;
        }

        if (config.matchingRule === "adjacent") {
            const blankLines = countBlankLinesBetween(lines, block.endLine + 1, symbolLine - 1);
            if (blankLines > config.maxBlankLines) {
                return undefined;
            }
        }

        const parsed = parseComment(block.lines, config.fieldLabels);
        const matchesName = matchesLabel(parsed, kind, symbolName);
        const hasAnyLabel = hasAnyLabelForKind(parsed, kind);

        if (config.requireLabelMatch) {
            if (matchesName) {
                return block;
            }
        } else if (matchesName || !hasAnyLabel) {
            return block;
        }

        if (config.matchingRule === "adjacent") {
            return undefined;
        }
    }

    return undefined;
}

function matchesLabel(parsed: ParsedComment, kind: SymbolKind, symbolName: string): boolean {
    switch (kind) {
        case "Class":
            return !!parsed.className && equalsIgnoreCase(parsed.className, symbolName);
        case "Method":
            return !!parsed.methodName && equalsIgnoreCase(parsed.methodName, symbolName);
        case "Property":
            return !!parsed.propertyName && equalsIgnoreCase(parsed.propertyName, symbolName);
        case "Field":
            return !!parsed.fieldName && equalsIgnoreCase(parsed.fieldName, symbolName);
        default:
            return false;
    }
}

function hasAnyLabelForKind(parsed: ParsedComment, kind: SymbolKind): boolean {
    switch (kind) {
        case "Class":
            return !!parsed.className;
        case "Method":
            return !!parsed.methodName;
        case "Property":
            return !!parsed.propertyName;
        case "Field":
            return !!parsed.fieldName;
        default:
            return false;
    }
}

function countBlankLinesBetween(lines: string[], startLine: number, endLine: number): number {
    let count = 0;
    for (let line = startLine; line <= endLine; line++) {
        if (line < 0 || line >= lines.length) {
            continue;
        }
        if (lines[line].trim() === "") {
            count += 1;
        }
    }
    return count;
}

function selectTemplate(
    kind: SymbolKind,
    fallback: string,
    templateByKind: OutputTemplateByKind
): string {
    const key = kind.toLowerCase() as keyof OutputTemplateByKind;
    return templateByKind[key] ?? fallback;
}

function formatArgs(args: string[], format: ArgsFormat): string {
    if (args.length === 0 || format === "none") {
        return "";
    }
    if (format === "inline") {
        return args.join(", ");
    }
    return args.map((arg) => `- ${arg}`).join("\n");
}

function getSignature(
    document: vscode.TextDocument,
    startLine: number,
    symbolName: string,
    kind: SymbolKind
): string | undefined {
    if (kind === "Class" || kind === "Method" || kind === "Property" || kind === "Field") {
        const maxLines = 5;
        let combined = "";
        for (let i = startLine; i < Math.min(document.lineCount, startLine + maxLines); i++) {
            combined += ` ${document.lineAt(i).text.trim()}`;
            if (combined.includes("{") || combined.includes(";")) {
                break;
            }
        }

        const trimmed = combined.trim();
        const cutIndex = findFirstIndex(trimmed, ["{", ";"]);
        const signature = (cutIndex >= 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();

        if (signature.includes(symbolName)) {
            return signature;
        }
    }
    return undefined;
}

function findFirstIndex(text: string, tokens: string[]): number {
    let min = -1;
    for (const token of tokens) {
        const index = text.indexOf(token);
        if (index >= 0 && (min === -1 || index < min)) {
            min = index;
        }
    }
    return min;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function equalsIgnoreCase(a: string, b: string): boolean {
    return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}
