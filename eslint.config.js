import { rxova } from "@rxova/repo-config/eslint";
import tseslint from "typescript-eslint";

// The packages and their tests import siblings by relative path: tsdown bundles
// `src/` as written, with no `@/` alias to resolve.
export default rxova({
  tsconfigRootDir: import.meta.dirname,
  strict: true,
  node: true,
  tests: true,
  extends: [tseslint.configs.stylisticTypeChecked],
});
