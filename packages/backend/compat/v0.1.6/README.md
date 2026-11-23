The schema of Panara Cloud 0.1.6 (`schema.ts` and `tables/` from git tag `v0.1.6`,
`git show v0.1.6:packages/backend/convex/...`), with the two validators its tables import
from `convex/lib`. `convex/compat.test.ts` stores what this version writes and checks that
0.1.6's schema still accepts it, so rolling back to 0.1.6 does not fail schema validation.
Replace it with the previous release's schema when a release changes what may be stored.
