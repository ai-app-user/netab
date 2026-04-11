import { runBasicCrudPlayground } from './basic.js';

runBasicCrudPlayground('postgres').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
