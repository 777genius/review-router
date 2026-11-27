/** @type {import('jest').Config} */
module.exports = {
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      {
        presets: [['@babel/preset-typescript', { allowDeclareFields: true }]],
        plugins: [
          '@babel/plugin-transform-dynamic-import',
          '@babel/plugin-transform-modules-commonjs',
        ],
      },
    ],
  },
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts', '!**/__tests__/helpers/**'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testTimeout: 10000, // 10 seconds per test
};
