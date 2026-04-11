import { pathToFileURL } from 'node:url';
import {
  createCoordPlaygroundRegistry,
  defaultCoordFiles,
  runCoordPlayground,
} from '../coord_runtime.js';

function isMainModule(): boolean {
  return (
    Boolean(process.argv[1]) &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

export { createCoordPlaygroundRegistry, defaultCoordFiles, runCoordPlayground };

if (isMainModule()) {
  runCoordPlayground(process.argv.slice(2), defaultCoordFiles()).then(
    (code) => {
      process.exitCode = code;
    },
  );
}
