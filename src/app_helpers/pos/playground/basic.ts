import { CordNode, CordRegistry } from '../../../cord/index.js';
import { StengEngine } from '../../../steng/index.js';
import { NetabDirectory, NetabService } from '../../../netab/index.js';
import { PosHelper } from '../index.js';

async function main() {
  const registry = new CordRegistry();
  const directory = new NetabDirectory();
  const steng = new StengEngine();
  const cord = new CordNode(registry, {
    clusterId: 'offline',
    nodeId: 'tablet-a',
    priority: 10,
    steng,
  });

  const service = new NetabService({
    app: 'pos',
    db: 'miami1',
    clusterId: 'offline',
    nodeId: 'tablet-a',
    steng,
    cord,
    directory,
    dbSecrets: { miami1: 'secret-miami1' },
    sites: [
      {
        siteId: 'site_brasao_miami1',
        locationId: 'miami1',
        brandId: 'brand_brasao',
        brandName: 'Brasao',
        db: 'miami1',
        public: true,
      },
    ],
    joinCodes: {
      JOIN123: 'site_brasao_miami1',
    },
  });
  await service.start();

  const helper = new PosHelper({
    clientOptions: { app: 'pos', db: 'miami1', service },
  });
  await helper.connect_by_qr({ joinCode: 'JOIN123' });
  console.log(helper.get_context());

  await service.stop();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
