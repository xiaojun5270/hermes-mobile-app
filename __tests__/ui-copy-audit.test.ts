import path from 'node:path';

const { collect, auditSource } = require('../scripts/ui-copy-audit.cjs');

test('owned UI text, placeholders, headers and accessibility include no unapproved English, including template fragments', () => {
  const result = collect(path.resolve(__dirname, '..'));
  expect(result.inventory.length).toBeGreaterThan(300);
  expect(result.violations).toEqual([]);
});

test('AST excludes only case expressions, pairing wire JSON and theme color values', () => {
  const result = auditSource('src/app/pair.tsx', `
    function pushLabel(state: string) {
      switch (state) { case 'registered': return '已开启'; default: return '已关闭'; }
    }
    const palettes: Record<string, ThemeColors> = { dark: { placeholder: '#5C5A54' } };
    const Pair = () => <TextInput placeholder='{"url":"http://…:9119","rt":"…","device_id":"…"}' />;
  `);
  expect(result.violations).toEqual([]);
});

test('AST still catches English display in case bodies, non-pairing JSON, UI colors and template fragments', () => {
  const result = auditSource('src/app/pair.tsx', `
    function pushLabel(state: string) {
      switch (state) { case 'registered': return 'Enabled'; default: return '已关闭'; }
    }
    const Pair = () => <><TextInput placeholder='{"label":"English"}' />
      <TextInput placeholder="#5C5A54" /><Text>{count} messages</Text>
      <Text accessibilityLabel={\`\${name} enabled\`} /></>;
  `);
  expect(result.violations.map((entry: { text: string }) => entry.text)).toEqual([
    'Enabled', '{"label":"English"}', '#5C5A54', 'messages', 'enabled',
  ]);
});

test('pairing JSON exemption is limited to the pairing input and exact wire keys', () => {
  const json = '{"url":"http://…:9119","rt":"…","device_id":"…"}';
  expect(auditSource('src/app/other.tsx', `<TextInput placeholder='${json}' />`).violations).toHaveLength(1);
  expect(auditSource('src/app/pair.tsx', `<Text>{'${json}'}</Text>`).violations).toHaveLength(1);
});
