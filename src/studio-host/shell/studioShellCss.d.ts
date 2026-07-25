/**
 * The shell entry imports its stylesheet so esbuild emits a matching
 * `studio-shell.css` next to the bundle. TypeScript needs to be told the import
 * is a side effect with no value.
 */
declare module '*.css';
