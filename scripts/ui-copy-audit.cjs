const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');

const DISPLAY_PROPS = new Set(['title', 'label', 'a11y', 'placeholder', 'accessibilityLabel', 'accessibilityHint']);
const DISPLAY_FUNCTIONS = new Set([
  'greetingForHour', 'timeAgo', 'timeUntil', 'countdownA11y', 'provenanceText', 'secureEntryCopy',
  'pricingLine', 'hintBadges', 'capabilityBadges', 'formatContext', 'fileSize', 'formatBytes',
  'statusLine', 'testSummary', 'pushLabel', 'schedulePreview', 'memoryWriteErrorMessage',
]);
const TECHNICAL = new Set([
  'Hermes', 'H', 'Face ID', 'OAuth', 'JSONL', 'URL', 'MCP', 'B', 'KB', 'MB', 'K', 'M', 'k',
  'MEMORY.md', 'USER.md', 'SKILL.md', 'Skills Hub', 'hermes mobile pair', 'hermes cron add',
  'https://example.com/mcp', 'http://', 'sf:', '▍',
]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? (['__tests__', 'vendor'].includes(entry.name) ? [] : sourceFiles(path.join(dir, entry.name)))
    : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
}
function isDisplay(node, source) {
  if (ts.isJsxText(node)) return true;
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isTypeNode(p)) return false;
    if (ts.isCaseClause(p) && child === p.expression) return false;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (![ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(op)) return false;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && child === p.left) return false;
    }
    if (ts.isConditionalExpression(p) && child === p.condition) return false;
    if (ts.isJsxAttribute(p)) return DISPLAY_PROPS.has(p.name.getText(source));
    if (ts.isPropertyAssignment(p)) {
      if (DISPLAY_PROPS.has(p.name.getText(source))) {
        // `ThemeColors.placeholder` is a palette value, not an input placeholder.
        let owner = p.parent;
        while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
        if (owner && owner.name.getText(source) === 'palettes' && owner.type?.getText(source).includes('ThemeColors')) return false;
        return true;
      }
      // Values in styles, request params, and protocol-state records are not display copy.
      return false;
    }
    if (ts.isJsxElement(p)) return ['Text', 'Animated.Text', 'SectionLabel', 'SectionTitle', 'SectionNote', 'FieldError'].includes(p.openingElement.tagName.getText(source));
    if (ts.isCallExpression(p) && p.expression.getText(source) === 'Alert.alert') return true;
    if (ts.isFunctionDeclaration(p) && p.name) return DISPLAY_FUNCTIONS.has(p.name.text);
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      if (ts.isVariableDeclaration(p.parent)) return DISPLAY_FUNCTIONS.has(p.parent.name.getText(source));
    }
  }
  return false;
}
function isPairingExample(node, file) {
  if (file !== 'src/app/pair.tsx' || !ts.isStringLiteral(node) ||
    !ts.isJsxAttribute(node.parent) || node.parent.name.getText() !== 'placeholder') return false;
  try {
    const value = JSON.parse(node.text);
    return value && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'device_id,rt,url' &&
      Object.values(value).every((item) => typeof item === 'string') &&
      /^https?:\/\//.test(value.url);
  } catch {
    return false;
  }
}
function auditSource(file, contents) {
  const inventory = [];
  const violations = [];
    const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        isDisplay(node, source) && !isPairingExample(node, file)) {
        const text = node.text.trim();
        if (text) {
          const entry = { file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind: ts.SyntaxKind[node.kind], text };
          inventory.push(entry);
          if (/[A-Za-z]/.test(text) && !/[\u3400-\u9fff]/.test(text) && !TECHNICAL.has(text) &&
            !/^[\s\d.,:;~$%/()[\]+−*-]*$/.test(text)) violations.push(entry);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  return { inventory, violations };
}
function collect(root = process.cwd()) {
  const inventory = [];
  const violations = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const result = auditSource(path.relative(root, file), fs.readFileSync(file, 'utf8'));
    inventory.push(...result.inventory);
    violations.push(...result.violations);
  }
  return { inventory, violations };
}
module.exports = { collect, auditSource };
if (require.main === module) {
  const result = collect();
  if (process.argv.includes('--inventory')) console.log(JSON.stringify(result.inventory, null, 2));
  else console.log(JSON.stringify({ count: result.inventory.length, violations: result.violations }, null, 2));
  if (result.violations.length) process.exitCode = 1;
}
