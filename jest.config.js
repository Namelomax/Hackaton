/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^.+\\.(css|less|scss|sass)$': '<rootDir>/test/__mocks__/styleMock.ts',
    '^.+\\.(svg|png|jpg|jpeg|gif|webp|avif)$': '<rootDir>/test/__mocks__/fileMock.ts',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: true }],
  },
  // Дефолтный testMatch подхватывает любой .ts внутри __tests__, включая
  // не-тестовые модули (например, общие фикстуры). Требуем «.test.» в имени.
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)'],
  testPathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/node_modules/'],
  collectCoverageFrom: [
    'app/**/*.{ts,tsx}',
    'components/**/*.{ts,tsx}',
    'lib/**/*.{ts,tsx}',
    '!**/*.d.ts',
  ],
};

module.exports = config;
