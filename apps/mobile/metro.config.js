// Monorepo-aware Metro config.
// Two non-default behaviors:
//   1. watchFolders includes the workspace root so changes in
//      packages/shared trigger Metro reloads.
//   2. nodeModulesPaths walks up to the root so hoisted deps
//      (react, react-native, etc.) resolve from there.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Symlinks in bun workspaces — Metro needs this to traverse them.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
