import js from '@eslint/js'
import globals from 'globals'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['uploads', 'prisma/migrations']),
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      // ESM throughout ("type": "module"), running on Node >= 20.
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // An unused `catch (err)` binding is idiomatic where the point is to
      // swallow the error, and unused function args are how you skip an
      // earlier positional one. Express error middleware in particular MUST
      // declare all four params to be recognised as error middleware, so
      // flagging them would mean disabling the rule at every such handler.
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
])
