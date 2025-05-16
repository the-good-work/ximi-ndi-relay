# XIMI -> NDI Command Line Application

Got a command line interface working with either [Grandiose](https://github.com/Streampunk/grandiose) or [ndi.js](https://github.com/pandres95/ndi.js)

Both are node-gyp bindings to a C++ program that works with NDI.

## Grandiose

send audio binding was not done upstream, to get this working we have to write the bindings ourselves.

## ndi.js

Program seems to be calculating video stride with a set of fixed assumptions. Not sure if these assumptions are sound or we can override.
