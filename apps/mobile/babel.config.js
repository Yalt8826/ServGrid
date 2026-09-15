module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      [
        'babel-preset-expo',
        {
          // maplibre-gl's ESM build carries `import.meta.url`, and Metro's dev
          // server serves the web bundle as a classic <script defer>, where
          // `import.meta` is a parse-time SyntaxError that blanks the entire
          // app (root never mounts, no console error reaches the terminal).
          // babel-preset-expo's import-meta transform deliberately passes it
          // through on web clients unless this is set; the rewrite target,
          // `globalThis.__ExpoImportMetaRegistry`, is polyfilled by
          // @expo/metro-runtime, which is already in the entry graph.
          unstable_transformImportMeta: true,
        },
      ],
    ],
  };
};
