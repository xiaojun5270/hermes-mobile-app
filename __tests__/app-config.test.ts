// __tests__/app-config.test.ts
import appJson from '../app.json';
import pkg from '../package.json';
import lock from '../package-lock.json';

test('build3 declares Chinese identity, native language and matching release versions', () => {
  expect(appJson.expo.name).toBe('Hermes 智能体');
  expect(appJson.expo.version).toBe('1.0.2');
  expect(pkg.version).toBe('1.0.2');
  expect(appJson.expo.ios.buildNumber).toBe('3');
  expect(appJson.expo.ios.bundleIdentifier).toBe('com.dintinoconte.hermesmobile');
  expect(appJson.expo.ios.infoPlist).toMatchObject({
    CFBundleDevelopmentRegion: 'zh_CN', CFBundleLocalizations: ['zh_CN'],
  });
});

test('release versions update only the lock roots, never the two 1.0.1 dependencies', () => {
  expect(lock.version).toBe(pkg.version);
  expect(lock.packages[''].version).toBe(pkg.version);
  expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
  expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
  expect(lock.packages['node_modules/@humanwhocodes/module-importer']).toMatchObject({
    version: '1.0.1',
    resolved: 'https://registry.npmjs.org/@humanwhocodes/module-importer/-/module-importer-1.0.1.tgz',
    integrity: 'sha512-bxveV4V8v5Yb4ncFTT3rPSgZBOpCkjfK0y4oVVVJwIuDVBRMDXrPyXRL988i5ap9m9bnyEEjWfm5WkBmtffLfA==',
  });
  expect(lock.packages['node_modules/camelize']).toMatchObject({
    version: '1.0.1',
    resolved: 'https://registry.npmjs.org/camelize/-/camelize-1.0.1.tgz',
    integrity: 'sha512-dU+Tx2fsypxTgtLoE36npi3UqcjSSMNYfkqgmoEhtZrraP5VWq0K7FkWVTYa8eMPtnU/G2txVsfdCJTn9uzpuQ==',
  });
});
test('Face ID usage string comes from the expo-local-authentication config plugin', () => {
  const plugin = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-local-authentication') as
    | [string, { faceIDPermission?: string }]
    | undefined;
  expect(plugin?.[1].faceIDPermission).toMatch(/Face ID/);
  expect(JSON.stringify(appJson.expo.ios.infoPlist)).not.toContain('NSFaceIDUsageDescription');
  expect((pkg.dependencies as Record<string, string>)['expo-local-authentication']).toMatch(/^~57\./);
});
