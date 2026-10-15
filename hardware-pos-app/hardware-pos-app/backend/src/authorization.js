export const ROLE_PERMISSIONS = Object.freeze({
  owner: ['*'],
  manager: ['sales.read','sales.create','returns.create','shifts.read','shifts.manage','products.read','products.write','inventory.read','inventory.adjust','inventory.count','purchasing.read','purchasing.write','reports.read','audit.read','approvals.read','approvals.create','approvals.manage'],
  cashier: ['sales.read','sales.create','shifts.read','shifts.manage','products.read','approvals.read','approvals.create'],
  inventory: ['products.read','products.write','inventory.read','inventory.adjust','inventory.count','purchasing.read','purchasing.write','approvals.read','approvals.create'],
  accountant: ['sales.read','returns.read','shifts.read','reports.read','audit.read','approvals.read']
});
export function requiredPermission(method, path) {
  if ((path === '/auth/me' || path === '/auth/logout') && ['GET','POST'].includes(method)) return null;
  if (path === '/shop' && method === 'GET') return null;
  if (path === '/shop' && method === 'PATCH') return 'shop.manage';
  if ((path === '/users' && ['GET','POST'].includes(method)) || (path.startsWith('/users/') && method === 'PATCH')) return 'users.manage';
  if (path === '/audit-logs' && method === 'GET') return 'audit.read';
  if (path === '/approvals' && method === 'GET') return 'approvals.read';
  if (path === '/approvals' && method === 'POST') return 'approvals.create';
  if (/^\/approvals\/[^/]+\/decision$/.test(path) && method === 'POST') return 'approvals.manage';
  if (/^\/products\/[^/]+\/variants$/.test(path)) return method === 'POST' ? 'products.write' : '__deny__';
  if (/^\/products\/[^/]+\/history$/.test(path) && method === 'GET') return 'products.read';
  if (/^\/products\/barcode\/[^/]+$/.test(path) && method === 'GET') return 'products.read';
  if (/^\/products\/[^/]+\/units$/.test(path)) return method === 'GET' ? 'products.read' : method === 'POST' ? 'products.write' : '__deny__';
  if (/^\/products\/units\/[^/]+$/.test(path) && method === 'PATCH') return 'products.write';
  if (path.startsWith('/reports/') && method === 'GET') return 'reports.read';
  if ((path === '/sales' || /^\/sales\/[^/]+$/.test(path)) && method === 'GET') return 'sales.read';
  if (path === '/sales' && method === 'POST') return 'sales.create';
  if (/^\/sales\/[^/]+\/returns$/.test(path) && method === 'POST') return 'returns.create';
  if ((path === '/shifts/current' || path === '/shifts') && method === 'GET') return 'shifts.read';
  if (path === '/shifts/open' && method === 'POST' || /^\/shifts\/[^/]+\/(movements|close)$/.test(path) && method === 'POST') return 'shifts.manage';
  if (path === '/products' && method === 'GET' || path === '/inventory/balances' && method === 'GET') return 'products.read';
  if (path === '/products' && method === 'POST' || path.startsWith('/products/import') && method === 'POST' || /^\/products\/[^/]+$/.test(path) && method === 'PATCH') return 'products.write';
  if (path === '/inventory/adjustments' && method === 'POST') return 'inventory.adjust';
  if (path === '/inventory-counts' && method === 'GET' || /^\/inventory-counts\/[^/]+$/.test(path) && method === 'GET') return 'inventory.read';
  if (path === '/inventory-counts' && method === 'POST' || /^\/inventory-counts\/[^/]+\/items\/[^/]+$/.test(path) && method === 'PATCH' || /^\/inventory-counts\/[^/]+\/submit$/.test(path) && method === 'POST') return 'inventory.count';
  if (/^\/inventory-counts\/[^/]+\/decision$/.test(path) && method === 'POST') return 'approvals.manage';
  if (['/suppliers','/purchase-orders','/purchase-receipts'].includes(path)) return method === 'GET' ? 'purchasing.read' : method === 'POST' ? 'purchasing.write' : '__deny__';
  if (/^\/purchase-orders\/[^/]+\/receive$/.test(path) && method === 'POST') return 'purchasing.write';
  return '__deny__';
}
export function isAllowed(role, permission) {
  if (permission === null) return true;
  if (permission === '__deny__') return false;
  const allowed = ROLE_PERMISSIONS[role] || [];
  return allowed.includes('*') || allowed.includes(permission);
}
