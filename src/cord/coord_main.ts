import { runCoordCli } from './coord_runtime.js';

runCoordCli(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
