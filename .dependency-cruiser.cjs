// PD-1: 모듈 사이 의존은 아래 방향만 허용한다. 순환 의존은 금지한다.
//   common ← 나머지 모두
//   idempotency, realtime ← transactions, participants, settlement
const MODULES = [
  'common',
  'rooms',
  'participants',
  'transactions',
  'idempotency',
  'balances',
  'realtime',
  'settlement',
];
const ALLOWED = {
  common: [],
  rooms: ['common'],
  participants: ['common', 'idempotency', 'realtime'],
  transactions: ['common', 'idempotency', 'realtime'],
  idempotency: ['common'],
  balances: ['common'],
  realtime: ['common'],
  settlement: ['common', 'idempotency', 'realtime'],
};

const forbidden = [
  {
    name: 'no-circular',
    severity: 'error',
    comment: 'PD-1: 순환 의존을 만들지 않는다.',
    from: {},
    to: { circular: true },
  },
  ...MODULES.map((m) => {
    const allowed = [m, ...ALLOWED[m]];
    const denied = MODULES.filter((x) => !allowed.includes(x));
    return {
      name: `module-direction-${m}`,
      severity: 'error',
      comment: `PD-1: ${m}은(는) ${allowed.join(', ')}만 가져올 수 있다.`,
      from: { path: `^src/${m}/` },
      to: { path: `^src/(${denied.join('|')})/` },
    };
  }),
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden,
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$|^src/generated/' },
  },
};
