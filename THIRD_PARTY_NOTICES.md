# Attribution and third-party notices

## DSH Remote reference

This is an independent Cloudflare Workers port of the DSH Remote server/protocol,
not an upstream-endorsed release. Canonical project:
https://github.com/liguobao/ds-harness-remote . The compatibility reference fork is
https://github.com/AS214933/ds-harness-remote . Reference checkouts used during
implementation included revisions `eb5297b` and `d37678ee`; protocol compatibility
is tested within the documented limits, not guaranteed for every upstream release.

Retain the upstream notice for upstream-derived portions and the separate port
notice in [LICENSE](LICENSE). The upstream MIT notice is published at
https://github.com/AS214933/ds-harness-remote/blob/main/packages/plugin/LICENSE .
The upstream root package metadata also declares MIT; this notice does not assert
that third-party files lacking explicit grants can be copied without checking.

## Runtime dependencies

The application uses `@logto/js` and `jose`, with transitive runtime dependencies
recorded in the lockfile. Their licenses do not replace the port's license:

- `@logto/js`: MIT, Copyright (c) 2022 Silverhand.
- `@silverhand/essentials`: MIT, Copyright (c) 2021 Logto.
- `jose`: MIT, Copyright (c) 2018 Filip Skokan.
- `camelcase`, `camelcase-keys`, `map-obj`, `quick-lru`: MIT, respective package authors.
- `type-fest`: MIT OR CC0-1.0, respective package authors.

Package distributions in `node_modules` contain their complete notices. They are
not vendored into this source repository. When distributing a bundled Worker or a
container/tooling image, include applicable dependency license texts and bundled
legal comments; do not strip them or treat this summary as a substitute for each
package's notice. Development-only dependencies may carry other licenses and must
be reviewed separately if their binaries are redistributed.

## Common MIT permission text

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
