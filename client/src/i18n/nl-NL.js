import { common } from './parts/common.js';
import { shell } from './parts/shell.js';
import { admin } from './parts/admin.js';
import { purchasing } from './parts/purchasing.js';
import { receiving } from './parts/receiving.js';
import { payables } from './parts/payables.js';
import { master } from './parts/master.js';
import { sourcing } from './parts/sourcing.js';

export const nlNL = {
  ...common,
  ...shell,
  ...admin,
  ...purchasing,
  ...receiving,
  ...payables,
  ...master,
  ...sourcing
};
