module.exports = {
    root: true,
    env: { browser: true, node: true, es2022: true },
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    globals: { SillyTavern: 'readonly' },
    ignorePatterns: ['fonts/'],
    rules: {
        'no-undef': 'error',
        'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
    },
};
