import { runBasicCrudPlayground } from './basic.js';

runBasicCrudPlayground('sqlite').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
