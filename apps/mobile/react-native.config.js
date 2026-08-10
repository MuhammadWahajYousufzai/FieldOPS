module.exports = {
  dependencies: {
    // Expo's config can be missed when pnpm exposes the package through a
    // workspace symlink. Keep the native package namespace deterministic for
    // clean Android builds and CI.
    expo: {
      platforms: {
        android: {
          packageImportPath: 'import expo.modules.ExpoModulesPackage;',
        },
      },
    },
  },
};
