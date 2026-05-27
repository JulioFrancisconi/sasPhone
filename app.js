const APP_VERSION = '1.8.1';
const STORAGE_KEY = 'controle_celulares_v1';
const CLIENT_ID_KEY = 'controle_celulares_client_id';
const CLOUD_TABLE = 'jpstore_app_state';
const CLOUD_DEFAULT_ROW = 'jpstore';

// Configuração pública do Supabase. A publishable key não é senha; a segurança fica no Supabase Auth + RLS.
const SUPABASE_URL = 'https://iuvgrzuvnunmxhirxoeb.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_gRpbUs689QUWUng6vF7vuw_qWrOGelz';
const LOGIN_USER_EMAILS = { jpstore: 'jpstore@jpstore.local' };

const PAYMENT_METHODS = ['pix', 'debito', 'credito', 'financiamento sicoob', 'troca', 'dinheiro'];
const PRODUCT_TYPES = ['celular', 'acessorio'];
const EXPENSE_CATEGORIES = ['fornecedor', 'combustivel', 'capinha', 'pelicula', 'acessorios', 'frete', 'manutencao', 'aluguel', 'energia', 'internet', 'maquina/cartao', 'marketing', 'equipamento', 'outros'];

const titles = {
  dashboard: ['Dashboard', 'Resumo geral da loja'],
  produtos: ['Produtos e estoque', 'Cadastre celulares, acessórios e aparelhos vindos de troca'],
  clientes: ['Clientes', 'Dados básicos para localizar vendas'],
  vendas: ['Vendas', 'Venda com múltiplos produtos, formas de pagamento e troca'],
  caixa: ['Caixa e fechamento', 'Confira saldo único de caixa, despesas pagas e valor em estoque'],
  despesas: ['Despesas e contas', 'Controle pagamentos, parcelas e fornecedores'],
  fornecedores: ['Fornecedores', 'Cadastre contatos e acompanhe contas vinculadas'],
  relatorios: ['Relatórios', 'Resumo de vendas, estoque, trocas e contas a pagar'],
  backup: ['Backup', 'Exportar, importar ou limpar seus dados']
};

let state = loadState();
let currentView = 'dashboard';
let cloudClient = null;
let cloudChannel = null;
let cloudSaveTimer = null;
let isCloudLoading = false;
let isApplyingRemoteState = false;
let saleDraft = emptySaleDraft();
let cashClosingDate = today();
let editing = { product: null, client: null, supplier: null, sale: null };

const $ = (id) => document.getElementById(id);

function defaultState() {
  return {
    version: APP_VERSION,
    products: [],
    clients: [],
    suppliers: [],
    expenses: [],
    sales: [],
    settings: {
      openingCash: 0,
      cloud: {
        enabled: true,
        supabaseUrl: SUPABASE_URL,
        supabaseAnonKey: SUPABASE_PUBLISHABLE_KEY,
        rowId: CLOUD_DEFAULT_ROW,
        lastSync: '',
        lastSyncStatus: '',
        lastRemoteUpdate: '',
        lastPushSyncId: '',
        autoSync: true,
        pendingUpload: false
      }
    }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return normalizeState(defaultState());
    const parsed = JSON.parse(raw);
    const defaults = defaultState();
    return normalizeState({
      ...defaults,
      ...parsed,
      settings: {
        ...defaults.settings,
        ...(parsed.settings || {}),
        cloud: { ...defaults.settings.cloud, ...((parsed.settings || {}).cloud || {}) }
      }
    });
  } catch (e) {
    console.error(e);
    return normalizeState(defaultState());
  }
}

function normalizeState(data) {
  const defaults = defaultState();
  const normalized = {
    ...defaults,
    ...(data || {}),
    products: Array.isArray(data?.products) ? data.products : [],
    clients: Array.isArray(data?.clients) ? data.clients : [],
    suppliers: Array.isArray(data?.suppliers) ? data.suppliers : [],
    expenses: Array.isArray(data?.expenses) ? data.expenses : [],
    sales: Array.isArray(data?.sales) ? data.sales : [],
    settings: {
      ...defaults.settings,
      ...((data || {}).settings || {}),
      cloud: { ...defaults.settings.cloud, ...(((data || {}).settings || {}).cloud || {}) }
    }
  };

  normalized.products = normalized.products.map((original) => {
    const product = { ...original };
    product.qty = Number(product.qty || 0);
    product.cost = Number(product.cost || 0);
    product.price = Number(product.price || 0);
    if (!product.purchaseDate) product.purchaseDate = String(product.createdAt || today()).slice(0, 10);

    if (product.source === 'troca') {
      product.purchaseQty = product.purchaseQty ?? product.qty;
      product.purchaseCostTotal = Number(product.purchaseCostTotal || 0);
      product.purchasePaymentStatus = 'pago';
      product.supplierPayableAmount = 0;
      return product;
    }

    const soldQty = normalized.sales.reduce((sum, sale) => {
      return sum + (sale.items || []).reduce((itemSum, item) => itemSum + (item.productId === product.id ? Number(item.qty || 0) : 0), 0);
    }, 0);

    if (product.purchaseQty === undefined || product.purchaseQty === null || product.purchaseQty === '') {
      product.purchaseQty = product.qty + soldQty;
    }
    if (product.purchaseCostTotal === undefined || product.purchaseCostTotal === null || product.purchaseCostTotal === '') {
      product.purchaseCostTotal = Number(product.purchaseQty || 0) * Number(product.cost || 0);
    }
    if (product.supplierPayableAmount === undefined || product.supplierPayableAmount === null || product.supplierPayableAmount === '') {
      product.supplierPayableAmount = (product.purchasePaymentStatus || 'pago') === 'pendente' ? Number(product.purchaseCostTotal || 0) : 0;
    }
    if ((product.purchasePaymentStatus || 'pago') !== 'pendente') {
      product.supplierPayableAmount = 0;
    }
    return product;
  });

  return normalized;
}


function getClientInstanceId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = `client_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function hasLocalBusinessData() {
  return Boolean(
    (state.products || []).length ||
    (state.clients || []).length ||
    (state.suppliers || []).length ||
    (state.expenses || []).length ||
    (state.sales || []).length
  );
}

function activeElementIsFormField() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = String(active.tagName || '').toLowerCase();
  return ['input', 'textarea', 'select'].includes(tag);
}

function saveState(options = {}) {
  state.version = APP_VERSION;
  if (!options.skipCloud && !isApplyingRemoteState && isCloudConfigured()) {
    getCloudSettings().pendingUpload = true;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (!options.skipCloud && !isApplyingRemoteState) scheduleCloudSave();
}

function getCloudSettings() {
  state.settings = state.settings || defaultState().settings;
  state.settings.cloud = { ...defaultState().settings.cloud, ...(state.settings.cloud || {}) };
  return state.settings.cloud;
}

function isCloudConfigured() {
  const cloud = getCloudSettings();
  return Boolean(cloud.enabled && SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && cloud.rowId);
}

function initCloudClient(force = false) {
  const cloud = getCloudSettings();
  if (!isCloudConfigured()) return null;
  if (cloudClient && !force) return cloudClient;
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    cloud.lastSyncStatus = 'Biblioteca Supabase não carregou. Verifique a internet.';
    return null;
  }
  if (force) stopCloudRealtime();
  cloudClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return cloudClient;
}

function stateForCloud(syncId = '') {
  const clean = JSON.parse(JSON.stringify(state));
  clean.settings = clean.settings || {};
  clean.settings.cloud = {
    enabled: false,
    supabaseUrl: '',
    supabaseAnonKey: '',
    rowId: CLOUD_DEFAULT_ROW,
    lastSync: '',
    lastSyncStatus: '',
    lastRemoteUpdate: '',
    lastPushSyncId: '',
    autoSync: true,
    pendingUpload: false
  };
  clean.syncMeta = {
    clientId: getClientInstanceId(),
    syncId: syncId || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    syncedAt: new Date().toISOString()
  };
  return clean;
}

function mergeCloudState(cloudData) {
  const localCloud = getCloudSettings();
  const merged = normalizeState({
    ...defaultState(),
    ...(cloudData || {}),
    settings: {
      ...defaultState().settings,
      ...((cloudData || {}).settings || {}),
      cloud: localCloud
    }
  });
  delete merged.syncMeta;
  return merged;
}

function scheduleCloudSave() {
  if (isCloudLoading || !isCloudConfigured()) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => pushStateToCloud({ silent: true }), 700);
}

function stopCloudRealtime() {
  if (cloudClient && cloudChannel) {
    try { cloudClient.removeChannel(cloudChannel); } catch (error) { console.warn(error); }
  }
  cloudChannel = null;
}

async function loadLatestCloudState(options = {}) {
  if (!isCloudConfigured()) return false;
  const cloud = getCloudSettings();
  const client = initCloudClient();
  if (!client) return false;

  const { data, error } = await client
    .from(CLOUD_TABLE)
    .select('data, updated_at')
    .eq('id', cloud.rowId || CLOUD_DEFAULT_ROW)
    .maybeSingle();

  if (error) {
    cloud.lastSyncStatus = `Erro ao consultar banco: ${error.message}`;
    saveState({ skipCloud: true });
    return false;
  }

  if (!data || !data.data) {
    if (options.pushIfEmpty && hasLocalBusinessData()) {
      return pushStateToCloud({ silent: true });
    }
    return false;
  }

  const remoteUpdatedAt = data.updated_at || '';
  const localRemoteUpdate = cloud.lastRemoteUpdate || '';
  const shouldApply = options.force || !localRemoteUpdate || remoteUpdatedAt > localRemoteUpdate;
  if (!shouldApply) return false;

  return applyCloudData(data.data, remoteUpdatedAt, {
    silent: options.silent !== false,
    force: true,
    renderIfPossible: options.renderIfPossible !== false
  });
}

function startCloudRealtime() {
  const cloud = getCloudSettings();
  stopCloudRealtime();
  if (!isCloudConfigured() || cloud.autoSync === false) return;

  const client = initCloudClient();
  if (!client) return;

  const rowId = cloud.rowId || CLOUD_DEFAULT_ROW;
  cloudChannel = client
    .channel(`jpstore-app-state-${rowId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: CLOUD_TABLE, filter: `id=eq.${rowId}` },
      (payload) => {
        if (!payload || payload.eventType === 'DELETE') return;
        const row = payload.new || {};
        applyCloudData(row.data, row.updated_at, { silent: true, realtime: true, renderIfPossible: true });
      }
    )
    .subscribe((status) => {
      const currentCloud = getCloudSettings();
      if (status === 'SUBSCRIBED') {
        currentCloud.lastSyncStatus = 'Sincronização automática em tempo real ativa.';
        saveState({ skipCloud: true });
        loadLatestCloudState({ silent: true, pushIfEmpty: true, renderIfPossible: true });
        if (currentView === 'backup' && $('view')) renderBackup();
      }
      if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        currentCloud.lastSyncStatus = `Sincronização em tempo real não conectada: ${status}.`;
        saveState({ skipCloud: true });
        if (currentView === 'backup' && $('view')) renderBackup();
      }
    });
}

function ensureCloudSync() {
  if (!isCloudConfigured()) return;
  const cloud = getCloudSettings();
  if (cloud.autoSync !== false) startCloudRealtime();
  else loadLatestCloudState({ silent: true, pushIfEmpty: false, renderIfPossible: true });
}

function applyCloudData(cloudData, remoteUpdatedAt = '', options = {}) {
  if (!cloudData) return false;
  const syncMeta = cloudData.syncMeta || {};
  const cloud = getCloudSettings();

  if (!options.force && syncMeta.clientId === getClientInstanceId()) {
    cloud.lastRemoteUpdate = remoteUpdatedAt || cloud.lastRemoteUpdate || '';
    cloud.lastSync = new Date().toISOString();
    saveState({ skipCloud: true });
    return true;
  }

  if (remoteUpdatedAt && cloud.lastRemoteUpdate && remoteUpdatedAt <= cloud.lastRemoteUpdate && !options.force) {
    return false;
  }

  isCloudLoading = true;
  isApplyingRemoteState = true;
  state = mergeCloudState(cloudData);
  state.settings.cloud.lastRemoteUpdate = remoteUpdatedAt || state.settings.cloud.lastRemoteUpdate || '';
  state.settings.cloud.lastSync = new Date().toISOString();
  state.settings.cloud.lastSyncStatus = options.realtime
    ? 'Dados atualizados automaticamente por outro dispositivo.'
    : 'Dados atualizados pelo banco.';
  saveState({ skipCloud: true });
  isApplyingRemoteState = false;
  isCloudLoading = false;

  if (options.renderIfPossible !== false && !activeElementIsFormField()) {
    render();
    if (!options.silent) alertMsg('Dados atualizados pelo banco.');
  } else if (!options.silent) {
    alertMsg('Dados atualizados pelo banco. Atualize a tela para visualizar.');
  }
  return true;
}

async function pushStateToCloud(options = {}) {
  if (!isCloudConfigured()) return false;
  const cloud = getCloudSettings();
  const client = initCloudClient();
  if (!client) {
    if (!options.silent) alert(cloud.lastSyncStatus || 'Banco de dados não configurado.');
    return false;
  }
  const { data: authData, error: authError } = await client.auth.getUser();
  const userId = authData?.user?.id;
  if (authError || !userId) {
    cloud.lastSyncStatus = 'Faça login novamente para enviar dados ao banco.';
    cloud.pendingUpload = true;
    saveState({ skipCloud: true });
    if (!options.silent) alert(cloud.lastSyncStatus);
    return false;
  }
  const syncId = `${getClientInstanceId()}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const payload = stateForCloud(syncId);
  const updatedAt = new Date().toISOString();
  const { data, error } = await client
    .from(CLOUD_TABLE)
    .upsert({ id: cloud.rowId || CLOUD_DEFAULT_ROW, owner_id: userId, data: payload, updated_at: updatedAt }, { onConflict: 'id' })
    .select('updated_at')
    .maybeSingle();
  if (error) {
    cloud.lastSyncStatus = `Erro ao enviar para o banco: ${error.message}`;
    cloud.pendingUpload = true;
    saveState({ skipCloud: true });
    if (!options.silent) alert(cloud.lastSyncStatus);
    return false;
  }
  cloud.lastPushSyncId = syncId;
  cloud.pendingUpload = false;
  cloud.lastRemoteUpdate = data?.updated_at || updatedAt;
  cloud.lastSync = new Date().toISOString();
  cloud.lastSyncStatus = cloud.autoSync === false
    ? 'Sincronizado com o banco.'
    : 'Salvo no banco e aguardando atualizações em tempo real.';
  saveState({ skipCloud: true });
  if (!options.silent) alertMsg('Dados enviados para o banco com sucesso.');
  return true;
}

async function pullStateFromCloud(options = {}) {
  if (!isCloudConfigured()) {
    alert('Configure o Supabase antes de baixar os dados do banco.');
    return false;
  }
  const cloud = getCloudSettings();
  const client = initCloudClient();
  if (!client) {
    alert(cloud.lastSyncStatus || 'Banco de dados não configurado.');
    return false;
  }
  const { data, error } = await client
    .from(CLOUD_TABLE)
    .select('data, updated_at')
    .eq('id', cloud.rowId || CLOUD_DEFAULT_ROW)
    .maybeSingle();
  if (error) {
    cloud.lastSyncStatus = `Erro ao baixar do banco: ${error.message}`;
    saveState({ skipCloud: true });
    alert(cloud.lastSyncStatus);
    return false;
  }
  if (!data || !data.data) {
    alert('Ainda não existe nenhum dado salvo no banco. Use "Enviar meus dados para o banco" primeiro.');
    return false;
  }
  if (options.confirm !== false && !confirm('Baixar os dados do banco irá substituir os dados deste navegador. Continuar?')) return false;
  const applied = applyCloudData(data.data, data.updated_at, { silent: false, force: true, renderIfPossible: true });
  if (applied) alertMsg('Dados baixados do banco com sucesso.');
  return applied;
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function money(value) {
  const number = Number(value || 0);
  return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function numberValue(value) {
  if (typeof value === 'number') return value;
  const normalized = String(value || '').replace(/\./g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  return Number(normalized || 0);
}

function dateBR(value) {
  if (!value) return '-';
  const [y, m, d] = value.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function addMonths(dateString, months) {
  const [y, m, d] = dateString.split('-').map(Number);
  const date = new Date(y, m - 1 + months, d || 1);
  return date.toISOString().slice(0, 10);
}

function sanitize(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function alertMsg(message) {
  const box = $('alert');
  box.textContent = message;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 3500);
}

function loginEmailForUser(username) {
  const key = String(username || '').trim().toLowerCase();
  return LOGIN_USER_EMAILS[key] || (key.includes('@') ? key : '');
}

async function getAuthSession() {
  const client = initCloudClient();
  if (!client || !client.auth) return null;
  const { data } = await client.auth.getSession();
  return data?.session || null;
}

async function showApp() {
  const session = await getAuthSession();
  const logged = Boolean(session?.user);
  $('loginScreen').classList.toggle('hidden', logged);
  $('app').classList.toggle('hidden', !logged);
  if (logged) {
    render();
    ensureCloudSync();
  } else {
    stopCloudRealtime();
  }
}

function init() {
  initCloudClient();
  if (cloudClient?.auth) {
    cloudClient.auth.onAuthStateChange(() => showApp());
  }

  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = loginEmailForUser($('loginUser').value);
    const password = $('loginPass').value;
    if (!email || !password) {
      alert('Informe usuário e senha.');
      return;
    }
    const client = initCloudClient();
    if (!client?.auth) {
      alert('Não foi possível carregar a autenticação. Verifique a internet.');
      return;
    }
    const button = event.target.querySelector('button[type="submit"]');
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = 'Entrando...';
    const { error } = await client.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = oldText;
    if (error) {
      alert('Usuário ou senha inválidos.');
      return;
    }
    await loadLatestCloudState({ silent: true, pushIfEmpty: true, renderIfPossible: true });
    await showApp();
  });

  $('logoutBtn').addEventListener('click', async () => {
    stopCloudRealtime();
    const client = initCloudClient();
    if (client?.auth) await client.auth.signOut();
    showApp();
  });

  $('menuBtn').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
  $('quickBackupBtn').addEventListener('click', () => exportBackup());

  window.addEventListener('online', () => {
    if (!isCloudConfigured()) return;
    ensureCloudSync();
    if (getCloudSettings().pendingUpload) pushStateToCloud({ silent: true });
    else loadLatestCloudState({ silent: true, pushIfEmpty: true, renderIfPossible: true });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }

  showApp();
}

function renderNav() {
  const navItems = [
    ['dashboard', '📊 Dashboard'],
    ['produtos', '📦 Produtos'],
    ['clientes', '👤 Clientes'],
    ['vendas', '🧾 Vendas'],
    ['caixa', '💵 Caixa'],
    ['despesas', '💸 Despesas'],
    ['fornecedores', '🚚 Fornecedores'],
    ['relatorios', '📈 Relatórios'],
    ['backup', '💾 Backup']
  ];
  $('nav').innerHTML = navItems.map(([view, label]) => `<button class="nav-btn ${view === currentView ? 'active' : ''}" data-view="${view}">${label}</button>`).join('');
  document.querySelectorAll('.nav-btn').forEach((btn) => btn.addEventListener('click', () => {
    currentView = btn.dataset.view;
    document.querySelector('.sidebar').classList.remove('open');
    render();
  }));
}

function render() {
  renderNav();
  const [title, subtitle] = titles[currentView];
  $('pageTitle').textContent = title;
  $('pageSubtitle').textContent = subtitle;
  const views = {
    dashboard: renderDashboard,
    produtos: renderProducts,
    clientes: renderClients,
    vendas: renderSales,
    caixa: renderCash,
    despesas: renderExpenses,
    fornecedores: renderSuppliers,
    relatorios: renderReports,
    backup: renderBackup
  };
  views[currentView]();
}

function getProduct(id) { return state.products.find((p) => p.id === id); }
function getClient(id) { return state.clients.find((c) => c.id === id); }
function getSupplier(id) { return state.suppliers.find((s) => s.id === id); }

function calcInventory() {
  return state.products.reduce((acc, p) => {
    const qty = Number(p.qty || 0);
    acc.qty += qty;
    acc.cost += qty * Number(p.cost || 0);
    acc.price += qty * Number(p.price || 0);
    if (p.source === 'troca') {
      acc.tradeQty += qty;
      acc.tradeCost += qty * Number(p.cost || 0);
    }
    return acc;
  }, { qty: 0, cost: 0, price: 0, tradeQty: 0, tradeCost: 0 });
}

function productPurchaseTotal(product) {
  if (!product || product.source === 'troca') return 0;
  if (product.purchaseCostTotal !== undefined && product.purchaseCostTotal !== null && product.purchaseCostTotal !== '') {
    return Number(product.purchaseCostTotal || 0);
  }
  const qty = Number(product.purchaseQty ?? product.qty ?? 0);
  return qty * Number(product.cost || 0);
}

function productPayableTotal(product) {
  if (!product || product.source === 'troca') return 0;
  if ((product.purchasePaymentStatus || 'pago') !== 'pendente') return 0;
  if (product.supplierPayableAmount !== undefined && product.supplierPayableAmount !== null && product.supplierPayableAmount !== '') {
    return Number(product.supplierPayableAmount || 0);
  }
  return productPurchaseTotal(product);
}

function calcStockPurchasesTotal() {
  return (state.products || [])
    .filter((p) => p.source !== 'troca')
    .reduce((sum, p) => sum + productPurchaseTotal(p), 0);
}

function openStockPayables() {
  return (state.products || [])
    .filter((p) => p.source !== 'troca' && (p.purchasePaymentStatus || 'pago') === 'pendente')
    .map((p) => ({
      ...p,
      purchaseTotal: productPurchaseTotal(p),
      payableTotal: productPayableTotal(p),
      supplierName: getSupplier(p.supplierId)?.name || '-'
    }))
    .filter((p) => Number(p.payableTotal || 0) > 0);
}

function calcStockPayablesTotal() {
  return openStockPayables().reduce((sum, p) => sum + Number(p.payableTotal || 0), 0);
}

function calcSalesTotal() {
  return state.sales.reduce((acc, sale) => {
    acc.total += Number(sale.total || 0);
    acc.trade += Number(sale.tradeCredit || 0);
    acc.cash += saleCashReceived(sale);
    acc.received += saleReceivedWithoutTrade(sale);
    acc.profit += Number(sale.profit || 0);
    return acc;
  }, { total: 0, trade: 0, cash: 0, received: 0, profit: 0 });
}

function calcExpensesTotal() {
  return state.expenses.reduce((acc, expense) => {
    const total = Number(expense.total || 0);
    acc.total += total;
    (expense.installments || []).forEach((installment) => {
      const value = Number(installment.value || 0);
      if (installment.status === 'pago') acc.paid += value;
      else acc.open += value;
    });
    return acc;
  }, { total: 0, paid: 0, open: 0 });
}

function netEstimatedProfit() {
  return calcSalesTotal().profit - calcExpensesTotal().paid;
}

function flattenInstallments() {
  return state.expenses.flatMap((expense) => (expense.installments || []).map((installment) => ({
    ...installment,
    expenseId: expense.id,
    description: expense.description,
    category: expense.category,
    supplierId: expense.supplierId
  })));
}

function openPayables() {
  return flattenInstallments().filter((i) => i.status !== 'pago');
}

function paymentDestination(method) {
  if (method === 'troca') return 'estoque';
  return 'caixa';
}

function saleCashReceived(sale) {
  return (sale.payments || []).filter((p) => p.method !== 'troca').reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function saleMoneyReceived(sale) {
  return (sale.payments || []).filter((p) => p.method === 'dinheiro').reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function saleReceivedWithoutTrade(sale) {
  return saleCashReceived(sale);
}

function calcCashFlow(filter = {}) {
  const settings = state.settings || { openingCash: 0 };
  const start = filter.start || '';
  const end = filter.end || '';
  const inRange = (date) => {
    if (!date) return false;
    const d = String(date).slice(0, 10);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  };

  const result = {
    // Compatibilidade com a versão anterior: se existia saldo bancário inicial, ele entra no caixa único.
    openingCash: Number(settings.openingCash || 0) + Number(settings.openingBank || 0),
    salesCash: 0,
    tradeStockIn: 0,
    stockPurchasesCash: 0,
    expensesCash: 0,
    movements: []
  };

  (state.products || []).forEach((product) => {
    if (product.source === 'troca') return;
    const movementDate = String(product.purchaseDate || product.createdAt || today()).slice(0, 10);
    if (!inRange(movementDate)) return;
    const amount = productPurchaseTotal(product);
    if (amount <= 0) return;
    result.stockPurchasesCash += amount;
    result.movements.push({
      date: movementDate,
      type: (product.purchasePaymentStatus || 'pago') === 'pendente' ? 'compromisso estoque' : 'compra estoque',
      destination: 'caixa',
      description: `Compra/entrada: ${product.name}`,
      method: (product.purchasePaymentStatus || 'pago') === 'pendente' ? 'fornecedor pendente' : 'pago',
      amount: -amount
    });
  });

  state.sales.forEach((sale) => {
    if (!inRange(sale.date)) return;
    (sale.payments || []).forEach((payment) => {
      const amount = Number(payment.amount || 0);
      const destination = paymentDestination(payment.method);
      if (destination === 'caixa') result.salesCash += amount;
      if (amount > 0 && destination !== 'estoque') {
        result.movements.push({
          date: sale.date,
          type: 'entrada',
          destination: 'caixa',
          description: `Venda ${sale.items?.map((i) => i.name).join(', ') || ''}`,
          method: payment.method,
          amount
        });
      }
    });
    const tradeValue = Number(sale.tradeCredit || 0);
    if (tradeValue > 0) {
      result.tradeStockIn += tradeValue;
      result.movements.push({
        date: sale.date,
        type: 'entrada em estoque',
        destination: 'estoque',
        description: `Troca recebida: ${(sale.tradeIns || []).map((t) => t.name).join(', ')}`,
        method: 'troca',
        amount: tradeValue
      });
    }
  });

  flattenInstallments().forEach((installment) => {
    if (installment.status !== 'pago') return;
    const movementDate = installment.paidDate || installment.dueDate;
    if (!inRange(movementDate)) return;
    const amount = Number(installment.value || 0);
    result.expensesCash += amount;
    result.movements.push({
      date: movementDate,
      type: 'saida',
      destination: 'caixa',
      description: installment.description,
      method: installment.paymentMethod,
      amount: -amount
    });
  });

  result.cashBalance = result.openingCash + result.salesCash - result.stockPurchasesCash - result.expensesCash;
  result.netMovement = result.salesCash - result.stockPurchasesCash - result.expensesCash;
  return result;
}

function calcCashBalanceUntil(date) {
  return calcCashFlow({ end: date || today() });
}

function renderDashboard() {
  const inv = calcInventory();
  const sales = calcSalesTotal();
  const expenses = calcExpensesTotal();
  const flow = calcCashFlow();
  const payable = openPayables().reduce((sum, i) => sum + Number(i.value || 0), 0);
  const recentSales = [...state.sales].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const lowStock = state.products.filter((p) => Number(p.qty || 0) <= 1).slice(0, 6);

  $('view').innerHTML = `
    <div class="grid cols-4">
      ${metric('Caixa', money(flow.cashBalance), 'Investimento inicial + vendas - compras de estoque - despesas pagas')}
      ${metric('Valor em estoque', money(inv.cost), `${inv.qty} itens pelo custo de entrada`)}
      ${metric('A pagar fornecedores', money(calcStockPayablesTotal()), `${openStockPayables().length} produtos/entradas pendentes`)}
      ${metric('Lucro estimado', money(netEstimatedProfit()), 'Lucro bruto das vendas - despesas pagas')}
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <section class="card">
        <h3>Últimas vendas</h3>
        <p class="kpi-note">Inclui vendas com troca e acessórios.</p>
        ${table(recentSales, ['Data', 'Cliente', 'Total', 'Troca/estoque', 'Caixa', 'Lucro bruto'], (s) => [
          dateBR(s.date),
          sanitize(getClient(s.customerId)?.name || 'Cliente não informado'),
          money(s.total),
          money(s.tradeCredit),
          money(saleCashReceived(s)),
          money(s.profit)
        ])}
      </section>
      <section class="card">
        <h3>Estoque baixo / unitário</h3>
        <p class="kpi-note">Celulares normalmente ficam com quantidade 1.</p>
        ${table(lowStock, ['Produto', 'Tipo', 'Qtd.', 'Custo', 'Origem'], (p) => [
          sanitize(p.name),
          badge(p.type),
          Number(p.qty || 0),
          money(p.cost),
          badge(p.source === 'troca' ? 'troca' : 'cadastro', p.source === 'troca' ? 'yellow' : 'gray')
        ])}
      </section>
    </div>
  `;
}

function metric(label, value, note) {
  return `<section class="card metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></section>`;
}

function table(rows, headers, mapper) {
  if (!rows.length) return '<div class="empty">Nenhum registro encontrado.</div>';
  const head = headers.map((h) => `<th>${h}</th>`).join('');
  const body = rows.map((row) => {
    const cells = mapper(row);
    return `<tr>${cells.map((c, index) => `<td data-label="${sanitize(headers[index] || '')}">${c}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function badge(text, color = 'gray') {
  return `<span class="badge ${color}">${sanitize(text)}</span>`;
}

function renderProducts() {
  const p = editing.product ? getProduct(editing.product) : null;
  const filtered = [...state.products].sort((a, b) => a.name.localeCompare(b.name));
  $('view').innerHTML = `
    <section class="card">
      <h3>${p ? 'Editar produto' : 'Cadastrar produto'}</h3>
      <form id="productForm" class="stack">
        <div class="row">
          <label>Tipo
            <select name="type">${PRODUCT_TYPES.map((t) => `<option ${p?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </label>
          <label>Nome/modelo
            <input name="name" required value="${sanitize(p?.name || '')}" placeholder="iPhone 17 256GB" />
          </label>
          <label>IMEI do aparelho
            <input name="imei" value="${sanitize(p?.imei || '')}" placeholder="Ex.: 35xxxxxxxxxxxxx" />
          </label>
        </div>
        <div class="row">
          <label>Data da compra/entrada
            <input name="purchaseDate" type="date" value="${sanitize(p?.purchaseDate || today())}" />
          </label>
          <label>Quantidade
            <input name="qty" type="number" min="0" step="1" required value="${p?.qty ?? 1}" />
          </label>
          <label>Custo unitário de entrada
            <input name="cost" inputmode="decimal" value="${p?.cost ?? ''}" placeholder="0,00" />
          </label>
          <label>Custo total da entrada / débito caixa
            <input name="purchaseCostTotal" inputmode="decimal" value="${p ? productPurchaseTotal(p) : ''}" placeholder="Auto: quantidade x custo" />
          </label>
          <label>Preço de venda
            <input name="price" inputmode="decimal" value="${p?.price ?? ''}" placeholder="0,00" />
          </label>
          <label>Estado
            <select name="condition">
              ${['lacrado', 'novo', 'seminovo', 'usado', 'troca', 'outro'].map((c) => `<option ${p?.condition === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="row">
          <label>Status
            <select name="status">
              ${['ativo', 'reservado', 'aguardando entrega', 'vendido', 'inativo'].map((s) => `<option ${p?.status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </label>
          <label>Fornecedor
            <select name="supplierId">
              <option value="">Sem fornecedor</option>
              ${state.suppliers.map((s) => `<option value="${s.id}" ${p?.supplierId === s.id ? 'selected' : ''}>${sanitize(s.name)}</option>`).join('')}
            </select>
          </label>
          <label>Pagamento fornecedor
            <select name="purchasePaymentStatus">
              ${['pago', 'pendente'].map((status) => `<option value="${status}" ${(p?.purchasePaymentStatus || 'pago') === status ? 'selected' : ''}>${status}</option>`).join('')}
            </select>
          </label>
          <label>Valor ainda a pagar ao fornecedor
            <input name="supplierPayableAmount" inputmode="decimal" value="${p ? productPayableTotal(p) : ''}" placeholder="Ex.: 200,00 ou custo total" />
          </label>
          <label>Vencimento fornecedor
            <input name="purchaseDueDate" type="date" value="${sanitize(p?.purchaseDueDate || '')}" />
          </label>
        </div>
        <div class="row">
          <label>Observação
            <input name="notes" value="${sanitize(p?.notes || '')}" placeholder="Ex.: veio de fornecedor X" />
          </label>
        </div>
        <p class="kpi-note">O <b>custo total da entrada</b> sempre diminui o caixa projetado e aumenta o valor em estoque. Se a compra ficou com carência, marque como pendente e informe apenas o <b>valor ainda a pagar ao fornecedor</b>.</p>
        <div class="actions">
          <button class="primary" type="submit">${p ? 'Salvar alteração' : 'Cadastrar'}</button>
          ${p ? '<button class="secondary" type="button" id="cancelProductEdit">Cancelar</button>' : ''}
        </div>
      </form>
    </section>

    <section class="card" style="margin-top:16px">
      <h3>Estoque</h3>
      <input class="searchbar" id="productSearch" placeholder="Pesquisar produto, IMEI, fornecedor ou origem..." />
      <div id="productsTable"></div>
    </section>
  `;
  $('productForm').addEventListener('submit', saveProduct);
  $('cancelProductEdit')?.addEventListener('click', () => { editing.product = null; renderProducts(); });
  $('productSearch').addEventListener('input', renderProductsTable);
  renderProductsTable();
}

function renderProductsTable() {
  const query = ($('productSearch')?.value || '').toLowerCase();
  const rows = state.products
    .filter((p) => [p.name, p.imei, p.type, p.source, p.condition, getSupplier(p.supplierId)?.name].join(' ').toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));
  $('productsTable').innerHTML = table(rows, ['Produto', 'IMEI', 'Tipo', 'Fornecedor', 'Data compra', 'Qtd.', 'Custo unit.', 'Débito caixa', 'A pagar', 'Venda', 'Pgto.', 'Origem', 'Ações'], (p) => [
    `<b>${sanitize(p.name)}</b><br><small>${sanitize(p.notes || '')}</small>`,
    sanitize(p.imei || '-'),
    badge(p.type),
    sanitize(getSupplier(p.supplierId)?.name || '-'),
    p.purchaseDate ? dateBR(p.purchaseDate) : '-',
    Number(p.qty || 0),
    money(p.cost),
    money(productPurchaseTotal(p)),
    money(productPayableTotal(p)),
    money(p.price),
    badge(p.source === 'troca' ? 'troca' : (p.purchasePaymentStatus || 'pago'), p.source === 'troca' ? 'yellow' : (p.purchasePaymentStatus || 'pago') === 'pendente' ? 'red' : 'green'),
    badge(p.source === 'troca' ? 'troca' : 'cadastro', p.source === 'troca' ? 'yellow' : 'gray'),
    `<div class="actions"><button class="secondary" onclick="editProduct('${p.id}')">Editar</button>${productPayableTotal(p) > 0 ? `<button class="success" onclick="markStockPayablePaid('${p.id}')">Marcar pago</button>` : ''}<button class="danger" onclick="deleteProduct('${p.id}')">Excluir</button></div>`
  ]);
}

function saveProduct(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const previousProduct = getProduct(editing.product);
  const qty = Number(form.get('qty') || 0);
  const cost = numberValue(form.get('cost'));
  const informedPurchaseTotal = numberValue(form.get('purchaseCostTotal'));
  const purchaseCostTotal = informedPurchaseTotal > 0 ? informedPurchaseTotal : qty * cost;
  const paymentStatus = form.get('purchasePaymentStatus') || 'pago';
  const informedPayable = numberValue(form.get('supplierPayableAmount'));
  const supplierPayableAmount = paymentStatus === 'pendente'
    ? (informedPayable > 0 ? informedPayable : (previousProduct ? productPayableTotal(previousProduct) || purchaseCostTotal : purchaseCostTotal))
    : 0;
  const product = {
    id: editing.product || uid('prod'),
    type: form.get('type'),
    name: form.get('name').trim(),
    imei: form.get('imei').trim(),
    qty,
    cost,
    purchaseQty: previousProduct?.purchaseQty ?? qty,
    purchaseCostTotal,
    purchasePaymentStatus: paymentStatus,
    supplierPayableAmount,
    purchaseDueDate: form.get('purchaseDueDate') || '',
    purchaseDate: form.get('purchaseDate') || previousProduct?.purchaseDate || today(),
    price: numberValue(form.get('price')),
    condition: form.get('condition'),
    status: form.get('status'),
    supplierId: form.get('supplierId') || '',
    source: previousProduct?.source || 'cadastro',
    notes: form.get('notes').trim(),
    createdAt: previousProduct?.createdAt || new Date().toISOString()
  };
  if (product.imei && state.products.some((x) => x.imei === product.imei && x.id !== product.id)) {
    alert('Já existe um produto com esse IMEI/código.');
    return;
  }
  if (editing.product) {
    state.products = state.products.map((x) => x.id === product.id ? product : x);
  } else {
    state.products.push(product);
  }
  editing.product = null;
  saveState();
  alertMsg('Produto salvo com sucesso.');
  renderProducts();
}

window.editProduct = (id) => { editing.product = id; renderProducts(); };
window.deleteProduct = (id) => {
  if (!confirm('Excluir este produto?')) return;
  if (state.sales.some((s) => s.items.some((i) => i.productId === id))) {
    alert('Este produto já está vinculado a uma venda. Para manter o histórico, deixe com status inativo em vez de excluir.');
    return;
  }
  state.products = state.products.filter((p) => p.id !== id);
  saveState();
  renderProducts();
};

function renderClients() {
  const c = editing.client ? getClient(editing.client) : null;
  $('view').innerHTML = `
    <section class="card">
      <h3>${c ? 'Editar cliente' : 'Cadastrar cliente'}</h3>
      <form id="clientForm" class="stack">
        <div class="row">
          <label>Nome
            <input name="name" required value="${sanitize(c?.name || '')}" placeholder="Nome do cliente" />
          </label>
          <label>Telefone/WhatsApp
            <input name="phone" value="${sanitize(c?.phone || '')}" placeholder="(48) 99999-9999" />
          </label>
          <label>CPF/CNPJ
            <input name="document" value="${sanitize(c?.document || '')}" />
          </label>
        </div>
        <div class="row">
          <label>E-mail
            <input name="email" type="email" value="${sanitize(c?.email || '')}" />
          </label>
          <label>Endereço
            <input name="address" value="${sanitize(c?.address || '')}" />
          </label>
        </div>
        <label>Observação
          <textarea name="notes">${sanitize(c?.notes || '')}</textarea>
        </label>
        <div class="actions">
          <button class="primary" type="submit">${c ? 'Salvar alteração' : 'Cadastrar'}</button>
          ${c ? '<button class="secondary" type="button" id="cancelClientEdit">Cancelar</button>' : ''}
        </div>
      </form>
    </section>
    <section class="card" style="margin-top:16px">
      <h3>Clientes cadastrados</h3>
      ${table([...state.clients].sort((a, b) => a.name.localeCompare(b.name)), ['Nome', 'Telefone', 'CPF/CNPJ', 'E-mail', 'Ações'], (c) => [
        `<b>${sanitize(c.name)}</b><br><small>${sanitize(c.address || '')}</small>`,
        sanitize(c.phone || '-'),
        sanitize(c.document || '-'),
        sanitize(c.email || '-'),
        `<div class="actions"><button class="secondary" onclick="editClient('${c.id}')">Editar</button><button class="danger" onclick="deleteClient('${c.id}')">Excluir</button></div>`
      ])}
    </section>
  `;
  $('clientForm').addEventListener('submit', saveClient);
  $('cancelClientEdit')?.addEventListener('click', () => { editing.client = null; renderClients(); });
}

function saveClient(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const client = {
    id: editing.client || uid('cli'),
    name: form.get('name').trim(),
    phone: form.get('phone').trim(),
    document: form.get('document').trim(),
    email: form.get('email').trim(),
    address: form.get('address').trim(),
    notes: form.get('notes').trim(),
    createdAt: getClient(editing.client)?.createdAt || new Date().toISOString()
  };
  if (editing.client) state.clients = state.clients.map((x) => x.id === client.id ? client : x);
  else state.clients.push(client);
  editing.client = null;
  saveState();
  alertMsg('Cliente salvo com sucesso.');
  renderClients();
}

window.editClient = (id) => { editing.client = id; renderClients(); };
window.deleteClient = (id) => {
  if (!confirm('Excluir este cliente?')) return;
  if (state.sales.some((s) => s.customerId === id)) {
    alert('Cliente possui venda vinculada. Para manter histórico, não é recomendado excluir.');
    return;
  }
  state.clients = state.clients.filter((c) => c.id !== id);
  saveState();
  renderClients();
};

function renderSuppliers() {
  const s = editing.supplier ? getSupplier(editing.supplier) : null;
  $('view').innerHTML = `
    <section class="card">
      <h3>${s ? 'Editar fornecedor' : 'Cadastrar fornecedor'}</h3>
      <form id="supplierForm" class="stack">
        <div class="row">
          <label>Nome
            <input name="name" required value="${sanitize(s?.name || '')}" placeholder="Fornecedor" />
          </label>
          <label>Telefone
            <input name="phone" value="${sanitize(s?.phone || '')}" />
          </label>
          <label>E-mail
            <input name="email" type="email" value="${sanitize(s?.email || '')}" />
          </label>
        </div>
        <label>Observação
          <textarea name="notes">${sanitize(s?.notes || '')}</textarea>
        </label>
        <div class="actions">
          <button class="primary" type="submit">${s ? 'Salvar alteração' : 'Cadastrar'}</button>
          ${s ? '<button class="secondary" type="button" id="cancelSupplierEdit">Cancelar</button>' : ''}
        </div>
      </form>
    </section>
    <section class="card" style="margin-top:16px">
      <h3>Fornecedores</h3>
      ${table([...state.suppliers].sort((a, b) => a.name.localeCompare(b.name)), ['Nome', 'Telefone', 'E-mail', 'Contas em aberto', 'Ações'], (s) => {
        const payable = openPayables().filter((i) => i.supplierId === s.id).reduce((sum, i) => sum + Number(i.value || 0), 0);
        return [
          `<b>${sanitize(s.name)}</b><br><small>${sanitize(s.notes || '')}</small>`,
          sanitize(s.phone || '-'),
          sanitize(s.email || '-'),
          money(payable),
          `<div class="actions"><button class="secondary" onclick="editSupplier('${s.id}')">Editar</button><button class="danger" onclick="deleteSupplier('${s.id}')">Excluir</button></div>`
        ];
      })}
    </section>
  `;
  $('supplierForm').addEventListener('submit', saveSupplier);
  $('cancelSupplierEdit')?.addEventListener('click', () => { editing.supplier = null; renderSuppliers(); });
}

function saveSupplier(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const supplier = {
    id: editing.supplier || uid('forn'),
    name: form.get('name').trim(),
    phone: form.get('phone').trim(),
    email: form.get('email').trim(),
    notes: form.get('notes').trim(),
    createdAt: getSupplier(editing.supplier)?.createdAt || new Date().toISOString()
  };
  if (editing.supplier) state.suppliers = state.suppliers.map((x) => x.id === supplier.id ? supplier : x);
  else state.suppliers.push(supplier);
  editing.supplier = null;
  saveState();
  alertMsg('Fornecedor salvo com sucesso.');
  renderSuppliers();
}

window.editSupplier = (id) => { editing.supplier = id; renderSuppliers(); };
window.deleteSupplier = (id) => {
  if (!confirm('Excluir este fornecedor?')) return;
  if (state.expenses.some((e) => e.supplierId === id)) {
    alert('Fornecedor possui despesas vinculadas.');
    return;
  }
  state.suppliers = state.suppliers.filter((s) => s.id !== id);
  saveState();
  renderSuppliers();
};

function emptySaleDraft() {
  return {
    date: today(),
    customerId: '',
    notes: '',
    warrantyDays: 90,
    discount: 0,
    items: [{ productId: '', qty: 1, price: 0 }],
    payments: [{ method: 'pix', amount: 0 }],
    trades: []
  };
}

function renderSales() {
  const selectedProductIds = new Set(saleDraft.items.map((i) => i.productId).filter(Boolean));
  const availableProducts = state.products.filter((p) => (Number(p.qty || 0) > 0 || selectedProductIds.has(p.id)) && p.status !== 'inativo');
  const recentSales = [...state.sales].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  $('view').innerHTML = `
    <section class="card">
      <h3>${editing.sale ? 'Editar venda' : 'Nova venda'}</h3>
      <p class="kpi-note">A troca entra automaticamente no estoque como um novo produto com custo igual ao valor abatido. Para capinha, película ou carregador de brinde, adicione o acessório na venda com preço R$ 0,00; o custo dele reduzirá o lucro bruto.</p>
      <div class="row">
        <label>Data
          <input id="saleDate" type="date" value="${saleDraft.date}" />
        </label>
        <label>Cliente
          <select id="saleCustomer">
            <option value="">Cliente não informado</option>
            ${state.clients.map((c) => `<option value="${c.id}" ${saleDraft.customerId === c.id ? 'selected' : ''}>${sanitize(c.name)}</option>`).join('')}
          </select>
        </label>
        <label>Dias de garantia
          <input id="saleWarrantyDays" type="number" min="0" step="1" value="${saleDraft.warrantyDays ?? 90}" />
        </label>
      </div>

      <div class="divider"></div>
      <h3>Produtos vendidos</h3>
      <div id="saleItems"></div>
      <button class="secondary" id="addSaleItem">+ Adicionar produto</button>

      <div class="divider"></div>
      <h3>Aparelhos recebidos na troca</h3>
      <p class="kpi-note">Ex.: vendeu iPhone 17 e pegou iPhone 13 como parte do pagamento. O iPhone 13 entra no estoque.</p>
      <div id="tradeItems"></div>
      <button class="secondary" id="addTradeItem">+ Adicionar troca</button>

      <div class="divider"></div>
      <h3>Pagamentos</h3>
      <p class="kpi-note">Formas fixas: pix, débito, crédito, financiamento Sicoob, troca e dinheiro.</p>
      <div id="paymentItems"></div>
      <button class="secondary" id="addPaymentItem">+ Adicionar pagamento</button>

      <div class="divider"></div>
      <div class="row">
        <label>Desconto da venda
          <input id="saleDiscount" inputmode="decimal" value="${saleDraft.discount || ''}" placeholder="0,00" />
        </label>
      </div>

      <div class="divider"></div>
      <label>Observação da venda
        <textarea id="saleNotes" placeholder="Ex.: cliente ficou de pagar parcela restante amanhã">${sanitize(saleDraft.notes)}</textarea>
      </label>
      <div id="saleTotals" style="margin-top:14px"></div>
      <div class="actions" style="margin-top:14px">
        <button class="primary" id="saveSaleBtn">${editing.sale ? 'Salvar alteração' : 'Salvar venda'}</button>
        <button class="secondary" id="clearSaleBtn">${editing.sale ? 'Cancelar edição' : 'Limpar venda'}</button>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h3>Vendas recentes</h3>
      ${table(recentSales, ['Data', 'Cliente', 'Itens', 'Total', 'Troca/Estoque', 'Caixa', 'Lucro bruto', 'Ações'], (s) => [
        dateBR(s.date),
        sanitize(getClient(s.customerId)?.name || 'Não informado'),
        sanitize(s.items.map((i) => `${i.qty}x ${i.name}`).join(', ')),
        money(s.total),
        money(s.tradeCredit),
        money(saleCashReceived(s)),
        money(s.profit),
        `<div class="actions"><button class="secondary" onclick="editSale('${s.id}')">Editar</button><button class="secondary" onclick="printSale('${s.id}')">Imprimir</button><button class="danger" onclick="deleteSale('${s.id}')">Excluir</button></div>`
      ])}
    </section>
  `;

  $('saleDate').addEventListener('change', (e) => { saleDraft.date = e.target.value; renderSaleTotals(); });
  $('saleCustomer').addEventListener('change', (e) => { saleDraft.customerId = e.target.value; });
  $('saleWarrantyDays').addEventListener('input', (e) => { saleDraft.warrantyDays = Number(e.target.value || 0); });
  $('saleDiscount').addEventListener('input', (e) => { saleDraft.discount = numberValue(e.target.value); renderSaleTotals(); });
  $('saleNotes').addEventListener('input', (e) => { saleDraft.notes = e.target.value; });
  $('addSaleItem').addEventListener('click', () => { saleDraft.items.push({ productId: '', qty: 1, price: 0 }); renderSales(); });
  $('addTradeItem').addEventListener('click', () => { saleDraft.trades.push({ name: '', imei: '', credit: 0, price: 0, condition: 'usado', notes: '' }); renderSales(); });
  $('addPaymentItem').addEventListener('click', () => { saleDraft.payments.push({ method: 'pix', amount: 0 }); renderSales(); });
  $('saveSaleBtn').addEventListener('click', saveSale);
  $('clearSaleBtn').addEventListener('click', () => { editing.sale = null; saleDraft = emptySaleDraft(); renderSales(); });
  renderSaleLines(availableProducts);
}

function renderSaleLines(availableProducts) {
  $('saleItems').innerHTML = saleDraft.items.map((item, index) => {
    const selected = getProduct(item.productId);
    const price = Number(item.price || selected?.price || 0);
    return `<div class="sale-line">
      <label>Produto
        <select onchange="updateSaleItem(${index}, 'productId', this.value)">
          <option value="">Selecione</option>
          ${availableProducts.map((p) => `<option value="${p.id}" ${item.productId === p.id ? 'selected' : ''}>${sanitize(p.name)}${p.imei ? ` | IMEI ${sanitize(p.imei)}` : ''} | qtd ${p.qty} | ${money(p.price)}</option>`).join('')}
        </select>
      </label>
      <label>Qtd.
        <input type="number" min="1" step="1" value="${item.qty}" onchange="updateSaleItem(${index}, 'qty', this.value)" />
      </label>
      <label>Preço un.
        <input inputmode="decimal" value="${price}" onchange="updateSaleItem(${index}, 'price', this.value)" />
      </label>
      <label>Subtotal
        <input disabled value="${money(Number(item.qty || 0) * price)}" />
      </label>
      <button class="danger" onclick="removeSaleItem(${index})">Remover</button>
    </div>`;
  }).join('');

  $('tradeItems').innerHTML = saleDraft.trades.length ? saleDraft.trades.map((t, index) => `<div class="trade-line">
    <label>Produto recebido
      <input value="${sanitize(t.name)}" placeholder="iPhone 13 128GB" onchange="updateTradeItem(${index}, 'name', this.value)" />
    </label>
    <label>IMEI/Série
      <input value="${sanitize(t.imei)}" placeholder="Opcional" onchange="updateTradeItem(${index}, 'imei', this.value)" />
    </label>
    <label>Valor abatido
      <input inputmode="decimal" value="${t.credit || ''}" onchange="updateTradeItem(${index}, 'credit', this.value)" />
    </label>
    <label>Preço venda sugerido
      <input inputmode="decimal" value="${t.price || ''}" onchange="updateTradeItem(${index}, 'price', this.value)" />
    </label>
    <label>Estado
      <select onchange="updateTradeItem(${index}, 'condition', this.value)">
        ${['seminovo', 'usado', 'troca', 'outro'].map((c) => `<option ${t.condition === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </label>
    <button class="danger" onclick="removeTradeItem(${index})">Remover</button>
  </div>`).join('') : '<div class="empty">Nenhuma troca adicionada nesta venda.</div>';

  $('paymentItems').innerHTML = saleDraft.payments.map((p, index) => `<div class="payment-line">
    <label>Forma
      <select onchange="updatePaymentItem(${index}, 'method', this.value)">
        ${PAYMENT_METHODS.map((m) => `<option ${p.method === m ? 'selected' : ''}>${m}</option>`).join('')}
      </select>
    </label>
    <label>Valor
      <input inputmode="decimal" value="${p.amount || ''}" onchange="updatePaymentItem(${index}, 'amount', this.value)" />
    </label>
    <button class="danger" onclick="removePaymentItem(${index})">Remover</button>
  </div>`).join('');

  renderSaleTotals();
}

window.updateSaleItem = (index, field, value) => {
  if (field === 'productId') {
    const product = getProduct(value);
    saleDraft.items[index].productId = value;
    saleDraft.items[index].price = product?.price || 0;
  } else if (field === 'qty') saleDraft.items[index].qty = Number(value || 0);
  else if (field === 'price') saleDraft.items[index].price = numberValue(value);
  renderSales();
};
window.removeSaleItem = (index) => { saleDraft.items.splice(index, 1); if (!saleDraft.items.length) saleDraft.items.push({ productId: '', qty: 1, price: 0 }); renderSales(); };
window.updateTradeItem = (index, field, value) => { saleDraft.trades[index][field] = ['credit', 'price'].includes(field) ? numberValue(value) : value; renderSaleTotals(); };
window.removeTradeItem = (index) => { saleDraft.trades.splice(index, 1); renderSales(); };
window.updatePaymentItem = (index, field, value) => { saleDraft.payments[index][field] = field === 'amount' ? numberValue(value) : value; renderSaleTotals(); };
window.removePaymentItem = (index) => { saleDraft.payments.splice(index, 1); if (!saleDraft.payments.length) saleDraft.payments.push({ method: 'pix', amount: 0 }); renderSales(); };

function saleTotals() {
  const itemsTotal = saleDraft.items.reduce((sum, item) => {
    const product = getProduct(item.productId);
    const price = Number(item.price || product?.price || 0);
    return sum + Number(item.qty || 0) * price;
  }, 0);

  const discount = Math.max(0, Number(saleDraft.discount || 0));
  const finalTotal = Math.max(0, itemsTotal - discount);
  const tradeCredit = saleDraft.trades.reduce((sum, t) => sum + Number(t.credit || 0), 0);
  const paid = saleDraft.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const paidCash = saleDraft.payments.filter((p) => p.method !== 'troca').reduce((sum, p) => sum + Number(p.amount || 0), 0);

  return {
    itemsTotal,
    discount,
    finalTotal,
    tradeCredit,
    paid,
    paidCash,
    grandPaid: tradeCredit + paid,
    balance: finalTotal - tradeCredit - paid
  };
}

function renderSaleTotals() {
  const t = saleTotals();
  $('saleTotals').innerHTML = `<div class="total-box">
    <div><span>Total dos produtos</span><strong>${money(t.itemsTotal)}</strong></div>
    <div><span>Desconto</span><strong>${money(t.discount)}</strong></div>
    <div><span>Valor final</span><strong>${money(t.finalTotal)}</strong></div>
    <div><span>Entra no caixa</span><strong>${money(t.paidCash)}</strong></div>
    <div><span>Entra no estoque/troca</span><strong>${money(t.tradeCredit)}</strong></div>
    <div><span>Diferença</span><strong>${money(t.balance)}</strong></div>
  </div>`;
}

function cloneCurrentState() {
  return JSON.parse(JSON.stringify(state));
}

function restoreStateSnapshot(snapshot) {
  state = snapshot;
}

function cannotReverseSaleMessage(sale) {
  for (const t of sale.tradeIns || []) {
    const product = getProduct(t.productId);
    if (product && Number(product.qty || 0) <= 0) {
      return `Não é possível alterar/excluir esta venda: o produto recebido na troca "${product.name}" já foi vendido ou saiu do estoque.`;
    }
  }
  return '';
}

function reverseSaleEffects(sale) {
  for (const item of sale.items || []) {
    const product = getProduct(item.productId);
    if (product) {
      product.qty = Number(product.qty || 0) + Number(item.qty || 0);
      if (product.status === 'vendido') product.status = 'ativo';
    }
  }
  for (const t of sale.tradeIns || []) {
    state.products = state.products.filter((p) => p.id !== t.productId);
  }
}

function saveSale() {
  saleDraft.date = $('saleDate').value;
  saleDraft.customerId = $('saleCustomer').value;
  saleDraft.notes = $('saleNotes').value;
  saleDraft.warrantyDays = Number($('saleWarrantyDays')?.value || 0);
  saleDraft.discount = numberValue($('saleDiscount')?.value || 0);

  const snapshot = cloneCurrentState();
  const editingSaleId = editing.sale;
  const oldSale = editingSaleId ? state.sales.find((s) => s.id === editingSaleId) : null;
  const saleId = editingSaleId || uid('venda');

  try {
    if (editingSaleId) {
      if (!oldSale) throw new Error('Venda original não encontrada para edição.');
      const blockMessage = cannotReverseSaleMessage(oldSale);
      if (blockMessage) throw new Error(blockMessage);
      reverseSaleEffects(oldSale);
      state.sales = state.sales.filter((s) => s.id !== editingSaleId);
    }

    const validItems = saleDraft.items.filter((i) => i.productId && Number(i.qty || 0) > 0);
    if (!validItems.length) throw new Error('Adicione pelo menos um produto vendido.');

    for (const item of validItems) {
      const p = getProduct(item.productId);
      if (!p) throw new Error('Produto inválido na venda.');
      if (Number(item.qty || 0) > Number(p.qty || 0)) throw new Error(`Estoque insuficiente para ${p.name}.`);
    }

    const validTrades = saleDraft.trades.filter((t) => t.name.trim() && Number(t.credit || 0) > 0);
    for (const t of validTrades) {
      if (t.imei && state.products.some((p) => p.imei === t.imei)) {
        throw new Error(`Já existe produto com o IMEI/código ${t.imei}.`);
      }
    }

    const totals = saleTotals();

    if (Number(totals.discount || 0) > Number(totals.itemsTotal || 0)) {
      throw new Error('O desconto não pode ser maior que o total dos produtos.');
    }

    if (Math.abs(totals.balance) > 0.01) {
      const confirmSave = confirm(`A venda está com diferença de ${money(totals.balance)}. Deseja salvar mesmo assim?`);
      if (!confirmSave) {
        restoreStateSnapshot(snapshot);
        return;
      }
    }
    if (validTrades.length && saleDraft.payments.some((p) => p.method === 'troca' && Number(p.amount || 0) > 0)) {
      const confirmTrade = confirm('Você adicionou troca no campo de troca e também pagamento manual como troca. Isso pode duplicar o valor. Deseja continuar?');
      if (!confirmTrade) {
        restoreStateSnapshot(snapshot);
        return;
      }
    }

    let profit = 0;
    const saleItems = validItems.map((item) => {
      const product = getProduct(item.productId);
      const qty = Number(item.qty || 0);
      const price = Number(item.price || product.price || 0);
      const cost = Number(product.cost || 0);
      product.qty = Number(product.qty || 0) - qty;
      if (product.qty <= 0 && product.type === 'celular') product.status = 'vendido';
      profit += (price - cost) * qty;
      return { productId: product.id, name: product.name, imei: product.imei || '', qty, price, cost, subtotal: qty * price };
    });

    const tradeIns = validTrades.map((t) => {
      const productId = uid('prod');
      state.products.push({
        id: productId,
        type: 'celular',
        name: t.name.trim(),
        imei: (t.imei || '').trim(),
        qty: 1,
        cost: Number(t.credit || 0),
        price: Number(t.price || 0),
        condition: t.condition || 'usado',
        status: 'ativo',
        supplierId: '',
        purchaseDate: saleDraft.date || today(),
        purchaseQty: 1,
        purchaseCostTotal: 0,
        purchasePaymentStatus: 'pago',
        supplierPayableAmount: 0,
        source: 'troca',
        sourceSaleId: saleId,
        notes: `Recebido em troca na venda ${saleId}. ${t.notes || ''}`.trim(),
        createdAt: new Date().toISOString()
      });
      return {
        name: t.name.trim(),
        imei: (t.imei || '').trim(),
        condition: t.condition || 'usado',
        notes: t.notes || '',
        productId,
        credit: Number(t.credit || 0),
        price: Number(t.price || 0)
      };
    });

    profit -= Number(totals.discount || 0);

    const payments = saleDraft.payments
      .filter((p) => Number(p.amount || 0) > 0)
      .map((p) => ({ method: p.method, amount: Number(p.amount || 0) }));
    const cashReceived = payments.filter((p) => p.method !== 'troca').reduce((sum, p) => sum + p.amount, 0);
    const paymentTradeCredit = payments.filter((p) => p.method === 'troca').reduce((sum, p) => sum + p.amount, 0);

    state.sales.push({
      id: saleId,
      date: saleDraft.date || today(),
      customerId: saleDraft.customerId,
      items: saleItems,
      tradeIns,
      payments,
      subtotal: saleItems.reduce((sum, i) => sum + i.subtotal, 0),
      discount: Number(totals.discount || 0),
      total: Number(totals.finalTotal || 0),
      tradeCredit: tradeIns.reduce((sum, t) => sum + Number(t.credit || 0), 0) + paymentTradeCredit,
      cashReceived,
      profit,
      notes: saleDraft.notes.trim(),
      warrantyDays: Number(saleDraft.warrantyDays || 0),
      createdAt: oldSale?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    saveState();
    editing.sale = null;
    saleDraft = emptySaleDraft();
    alertMsg(editingSaleId ? 'Venda alterada. Estoque, caixa e troca recalculados.' : 'Venda salva. Estoque, caixa e troca atualizados automaticamente.');
    renderSales();
  } catch (error) {
    restoreStateSnapshot(snapshot);
    alert(error.message || 'Não foi possível salvar a venda.');
  }
}

window.editSale = (id) => {
  const sale = state.sales.find((s) => s.id === id);
  if (!sale) return;
  const blockMessage = cannotReverseSaleMessage(sale);
  if (blockMessage) {
    alert(blockMessage);
    return;
  }
  editing.sale = id;
  saleDraft = {
    date: sale.date || today(),
    customerId: sale.customerId || '',
    notes: sale.notes || '',
    warrantyDays: sale.warrantyDays ?? 90,
    discount: Number(sale.discount || 0),
    items: (sale.items || []).map((item) => ({ productId: item.productId, qty: item.qty, price: item.price })),
    payments: (sale.payments && sale.payments.length ? sale.payments : [{ method: 'pix', amount: 0 }]).map((payment) => ({ method: payment.method, amount: payment.amount })),
    trades: (sale.tradeIns || []).map((trade) => ({
      name: trade.name || '',
      imei: trade.imei || '',
      credit: trade.credit || 0,
      price: trade.price || 0,
      condition: trade.condition || 'usado',
      notes: trade.notes || ''
    }))
  };
  renderSales();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.deleteSale = (id) => {
  const sale = state.sales.find((s) => s.id === id);
  if (!sale) return;
  if (!confirm('Excluir esta venda e tentar reverter o estoque?')) return;
  const blockMessage = cannotReverseSaleMessage(sale);
  if (blockMessage) {
    alert(blockMessage);
    return;
  }
  reverseSaleEffects(sale);
  state.sales = state.sales.filter((s) => s.id !== id);
  if (editing.sale === id) {
    editing.sale = null;
    saleDraft = emptySaleDraft();
  }
  saveState();
  renderSales();
};

window.printSale = (id) => {
  const sale = state.sales.find((s) => s.id === id);
  if (!sale) return;
  const client = getClient(sale.customerId);
  const nonTradePayments = (sale.payments || []).filter((p) => p.method !== 'troca' && Number(p.amount || 0) > 0);
  const hasTradePayment = Number(sale.tradeCredit || 0) > 0 || (sale.payments || []).some((p) => p.method === 'troca');
  const paymentLines = [
    ...nonTradePayments.map((p) => `<li>${sanitize(p.method)}: ${money(p.amount)}</li>`),
    ...(hasTradePayment ? ['<li>Troca</li>'] : [])
  ].join('') || '<li>Não informado</li>';
  const tradeLines = (sale.tradeIns || []).map((t) => `<li>${sanitize(t.name)}${t.imei ? ` - IMEI/Série: ${sanitize(t.imei)}` : ''}</li>`).join('');
  const warrantyDays = Number(sale.warrantyDays ?? 90);
  const html = `
    <html>
      <head>
        <title>Comprovante de Venda</title>
        <style>
          body{font-family:Arial,Helvetica,sans-serif;padding:24px;color:#111;max-width:760px;margin:auto}
          h1,h2,h3{margin:0 0 10px} .muted{color:#555;font-size:13px}
          .box{border:1px solid #ddd;border-radius:10px;padding:14px;margin:12px 0}
          table{width:100%;border-collapse:collapse;margin-top:8px} td,th{border:1px solid #ddd;padding:8px;text-align:left} th{background:#f5f5f5}
          .total{font-size:22px;font-weight:700;text-align:right;margin-top:16px}.sign{margin-top:42px;border-top:1px solid #333;width:320px;text-align:center;padding-top:8px}
          @media print{button{display:none} body{padding:0}}
        </style>
      </head>
      <body>
        <h1>Comprovante de Venda</h1>
        <p class="muted">Controle interno de venda</p>
        <div class="box">
          <p><b>Data:</b> ${dateBR(sale.date)}</p>
          <p><b>Cliente:</b> ${sanitize(client?.name || 'Não informado')}</p>
          ${client?.document ? `<p><b>CPF/CNPJ:</b> ${sanitize(client.document)}</p>` : ''}
          ${client?.phone ? `<p><b>Telefone:</b> ${sanitize(client.phone)}</p>` : ''}
        </div>
        <h3>Produtos vendidos</h3>
        <table>
          <tr><th>Produto</th><th>Qtd.</th><th>Valor un.</th><th>Total</th></tr>
          ${sale.items.map((i) => `<tr><td>${sanitize(i.name)}${i.imei ? `<br><span class="muted">IMEI: ${sanitize(i.imei)}</span>` : ''}</td><td>${i.qty}</td><td>${money(i.price)}</td><td>${money(i.subtotal)}</td></tr>`).join('')}
        </table>
        ${Number(sale.discount || 0) > 0 ? `<div class="box"><p><b>Subtotal:</b> ${money(sale.subtotal || sale.items.reduce((sum, i) => sum + Number(i.subtotal || 0), 0))}</p><p><b>Desconto:</b> -${money(sale.discount)}</p></div>` : ''}
        <div class="box">
          <h3>Formas de pagamento</h3>
          <ul>${paymentLines}</ul>
          ${tradeLines ? `<p><b>Aparelho recebido na troca:</b></p><ul>${tradeLines}</ul>` : ''}
        </div>
        <div class="box">
          <p><b>Garantia:</b> ${warrantyDays} dias a partir da data da venda.</p>
          <p class="muted">Garantia conforme condição combinada no momento da venda. Mau uso, queda, contato com líquido, oxidação e danos físicos podem invalidar a garantia.</p>
        </div>
        <div class="total">Valor final da venda: ${money(sale.total)}</div>
        <div class="sign">Assinatura do cliente</div>
        <script>window.print()</script>
      </body>
    </html>`;
  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
};


function renderCash() {
  const inv = calcInventory();
  const allFlow = calcCashFlow();
  const dayFlow = calcCashFlow({ start: cashClosingDate, end: cashClosingDate });
  const closingFlow = calcCashBalanceUntil(cashClosingDate);
  const settings = state.settings || (state.settings = { openingCash: 0 });
  const movements = [...dayFlow.movements].sort((a, b) => `${a.date}${a.description}`.localeCompare(`${b.date}${b.description}`));

  $('view').innerHTML = `
    <div class="grid cols-4">
      ${metric('Caixa atual/projetado', money(allFlow.cashBalance), 'Saldo inicial + entradas de venda - compras de estoque - despesas pagas')}
      ${metric('Valor em estoque', money(inv.cost), `${inv.qty} itens pelo custo de entrada`)}
      ${metric('A pagar fornecedores', money(calcStockPayablesTotal()), `${openStockPayables().length} compras pendentes`)}
      ${metric('Lucro estimado', money(netEstimatedProfit()), 'Lucro bruto das vendas - despesas pagas')}
    </div>

    <section class="card" style="margin-top:16px">
      <h3>Saldo inicial do caixa</h3>
      <p class="kpi-note">Informe o investimento/saldo inicial da loja. Exemplo: começou com R$ 5.000, comprou um iPhone por R$ 2.700 e vendeu por R$ 3.000: o caixa atual fica R$ 5.300 e o lucro bruto R$ 300.</p>
      <form id="cashSettingsForm" class="row" style="margin-top:12px">
        <label>Saldo inicial do caixa
          <input name="openingCash" inputmode="decimal" value="${Number(settings.openingCash || 0) + Number(settings.openingBank || 0)}" />
        </label>
        <button class="primary" type="submit">Salvar saldo</button>
      </form>
    </section>

    <section class="card" style="margin-top:16px">
      <h3>Fechamento por data</h3>
      <div class="row" style="margin-top:12px">
        <label>Data do fechamento
          <input id="cashClosingDate" type="date" value="${cashClosingDate}" />
        </label>
      </div>
      <div class="grid cols-4" style="margin-top:14px">
        ${metric('Caixa após esta data', money(closingFlow.cashBalance), 'Saldo inicial + todos os movimentos até a data')}
        ${metric('Resultado do dia', money(dayFlow.netMovement), 'Entradas do dia - saídas do dia')}
        ${metric('Entrou no caixa no dia', money(dayFlow.salesCash), 'Pix, dinheiro, débito, crédito e financiamento')}
        ${metric('Saiu para estoque no dia', money(dayFlow.stockPurchasesCash), 'Custo dos produtos cadastrados/comprados')}
      </div>
      <div class="grid cols-4" style="margin-top:14px">
        ${metric('Entrou em estoque/troca', money(dayFlow.tradeStockIn), 'Valor dos aparelhos pegos na troca')}
        ${metric('Despesas pagas no dia', money(dayFlow.expensesCash), 'Somente despesas marcadas como pagas')}
        ${metric('Valor em estoque atual', money(inv.cost), 'Estoque pelo custo de entrada')}
        ${metric('Fornecedor pendente', money(calcStockPayablesTotal()), 'Valor ainda aberto com fornecedores')}
      </div>
      <div class="divider"></div>
      <h3>Movimentos do dia</h3>
      ${table(movements, ['Data', 'Tipo', 'Destino', 'Descrição', 'Forma', 'Valor'], (m) => [
        dateBR(m.date),
        badge(m.type, m.type === 'saida' ? 'red' : m.destination === 'estoque' ? 'yellow' : 'green'),
        badge(m.destination || '-'),
        sanitize(m.description || '-'),
        badge(m.method || '-'),
        money(m.amount)
      ])}
    </section>

    <section class="card" style="margin-top:16px">
      <h3>Compras de estoque pendentes com fornecedores</h3>
      <p class="kpi-note">O custo total da compra já reduz o caixa projetado. O campo abaixo mostra somente o valor que você ainda marcou como pendente com a fornecedora.</p>
      ${table(openStockPayables().sort((a, b) => (a.purchaseDueDate || '').localeCompare(b.purchaseDueDate || '')), ['Compra', 'Vencimento', 'Produto', 'IMEI', 'Fornecedor', 'Custo total', 'Ainda a pagar', 'Ações'], (p) => [
        p.purchaseDate ? dateBR(p.purchaseDate) : '-',
        p.purchaseDueDate ? dateBR(p.purchaseDueDate) : '-',
        sanitize(p.name),
        sanitize(p.imei || '-'),
        sanitize(p.supplierName || '-'),
        money(p.purchaseTotal),
        money(p.payableTotal),
        `<button class="success" onclick="markStockPayablePaid('${p.id}')">Marcar pago</button>`
      ])}
    </section>

    <section class="card" style="margin-top:16px">
      <h3>Exemplos de cálculo</h3>
      <p class="kpi-note"><b>Compra/venda simples:</b> saldo inicial R$ 5.000 - compra iPhone 14 Pro R$ 2.700 + venda R$ 3.000 = caixa R$ 5.300; estoque zera; lucro bruto R$ 300.</p>
      <p class="kpi-note"><b>Compra acima do caixa:</b> caixa R$ 5.300 - compra iPhone 16 Pro Max R$ 5.500 = caixa R$ -200. Ao vender por R$ 5.800 recebendo R$ 3.800 no cartão + R$ 1.000 dinheiro + iPhone 11 de R$ 800, o caixa fica R$ 4.600 e o iPhone 11 entra no estoque por R$ 800.</p>
      <p class="kpi-note"><b>Pedido com carência:</b> cadastre o produto com o custo total, marque fornecedor pendente e informe o valor ainda a pagar. O caixa pode ficar negativo para mostrar o compromisso assumido.</p>
    </section>
  `;

  $('cashSettingsForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.settings = {
      ...(state.settings || {}),
      openingCash: numberValue(form.get('openingCash')),
      openingBank: 0
    };
    saveState();
    alertMsg('Saldo inicial do caixa salvo.');
    renderCash();
  });
  $('cashClosingDate').addEventListener('change', (event) => {
    cashClosingDate = event.target.value || today();
    renderCash();
  });
}

window.markStockPayablePaid = (id) => {
  const product = getProduct(id);
  if (!product) return;
  product.purchasePaymentStatus = 'pago';
  product.supplierPayableAmount = 0;
  product.purchasePaidDate = today();
  saveState();
  alertMsg('Compra marcada como paga.');
  render();
};

function renderExpenses() {
  const installments = flattenInstallments().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  $('view').innerHTML = `
    <section class="card">
      <h3>Adicionar despesa / conta de fornecedor</h3>
      <form id="expenseForm" class="stack">
        <div class="row">
          <label>Data da compra/despesa
            <input name="date" type="date" value="${today()}" required />
          </label>
          <label>Descrição
            <input name="description" required placeholder="Ex.: Compra fornecedor iPhones" />
          </label>
          <label>Categoria
            <select name="category">${EXPENSE_CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
          </label>
        </div>
        <div class="row">
          <label>Fornecedor
            <select name="supplierId"><option value="">Sem fornecedor</option>${state.suppliers.map((s) => `<option value="${s.id}">${sanitize(s.name)}</option>`).join('')}</select>
          </label>
          <label>Valor total
            <input name="total" inputmode="decimal" required placeholder="0,00" />
          </label>
          <label>Parcelas
            <input name="installments" type="number" min="1" step="1" value="1" />
          </label>
          <label>Primeiro vencimento
            <input name="firstDueDate" type="date" value="${today()}" required />
          </label>
        </div>
        <div class="row">
          <label>Forma de pagamento prevista
            <select name="paymentMethod">${PAYMENT_METHODS.filter((m) => m !== 'troca').map((m) => `<option>${m}</option>`).join('')}</select>
          </label>
          <label>Status inicial
            <select name="status"><option value="pendente">pendente</option><option value="pago">pago</option></select>
          </label>
        </div>
        <button class="primary" type="submit">Adicionar despesa</button>
      </form>
    </section>
    <section class="card" style="margin-top:16px">
      <h3>Contas e parcelas</h3>
      ${table(installments, ['Vencimento', 'Descrição', 'Categoria', 'Fornecedor', 'Valor', 'Status', 'Ações'], (i) => [
        dateBR(i.dueDate),
        sanitize(`${i.description} - parcela ${i.number}/${i.totalInstallments}`),
        badge(i.category),
        sanitize(getSupplier(i.supplierId)?.name || '-'),
        money(i.value),
        badge(i.status, i.status === 'pago' ? 'green' : 'yellow'),
        `<div class="actions"><button class="${i.status === 'pago' ? 'warning' : 'success'}" onclick="toggleInstallment('${i.expenseId}', '${i.id}')">${i.status === 'pago' ? 'Marcar pendente' : 'Marcar pago'}</button><button class="danger" onclick="deleteExpense('${i.expenseId}')">Excluir despesa</button></div>`
      ])}
    </section>
  `;
  $('expenseForm').addEventListener('submit', saveExpense);
}

function saveExpense(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const total = numberValue(form.get('total'));
  const count = Math.max(1, Number(form.get('installments') || 1));
  const baseValue = Math.round((total / count) * 100) / 100;
  let running = 0;
  const status = form.get('status');
  const installments = Array.from({ length: count }, (_, index) => {
    const value = index === count - 1 ? Math.round((total - running) * 100) / 100 : baseValue;
    running += value;
    return {
      id: uid('parc'),
      number: index + 1,
      totalInstallments: count,
      dueDate: addMonths(form.get('firstDueDate'), index),
      value,
      paymentMethod: form.get('paymentMethod'),
      status,
      paidDate: status === 'pago' ? addMonths(form.get('firstDueDate'), index) : ''
    };
  });
  state.expenses.push({
    id: uid('desp'),
    date: form.get('date'),
    description: form.get('description').trim(),
    category: form.get('category'),
    supplierId: form.get('supplierId'),
    total,
    installments,
    createdAt: new Date().toISOString()
  });
  saveState();
  alertMsg('Despesa adicionada.');
  renderExpenses();
}

window.toggleInstallment = (expenseId, installmentId) => {
  const expense = state.expenses.find((e) => e.id === expenseId);
  const installment = expense?.installments.find((i) => i.id === installmentId);
  if (!installment) return;
  installment.status = installment.status === 'pago' ? 'pendente' : 'pago';
  installment.paidDate = installment.status === 'pago' ? installment.dueDate : '';
  saveState();
  renderExpenses();
};

window.deleteExpense = (id) => {
  if (!confirm('Excluir esta despesa inteira, incluindo parcelas?')) return;
  state.expenses = state.expenses.filter((e) => e.id !== id);
  saveState();
  renderExpenses();
};

function renderReports() {
  const inv = calcInventory();
  const sales = calcSalesTotal();
  const expenses = calcExpensesTotal();
  const flow = calcCashFlow();
  const paymentMap = {};
  state.sales.forEach((s) => {
    (s.payments || []).filter((p) => p.method !== 'troca').forEach((p) => paymentMap[p.method] = (paymentMap[p.method] || 0) + Number(p.amount || 0));
    if (s.tradeCredit) paymentMap.troca = (paymentMap.troca || 0) + Number(s.tradeCredit || 0);
  });
  const paymentRows = Object.entries(paymentMap).map(([method, amount]) => ({ method, amount }));
  const tradeStock = state.products.filter((p) => p.source === 'troca');
  const payables = openPayables().sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
  const expenseRows = [...state.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  $('view').innerHTML = `
    <div class="grid cols-4">
      ${metric('Caixa', money(flow.cashBalance), 'Investimento inicial + vendas - compras de estoque - despesas pagas')}
      ${metric('Valor em estoque', money(inv.cost), `${inv.qty} itens pelo custo de entrada`)}
      ${metric('A pagar fornecedores', money(calcStockPayablesTotal()), `${openStockPayables().length} produtos/entradas pendentes`)}
      ${metric('Lucro estimado', money(netEstimatedProfit()), 'Lucro bruto das vendas - despesas pagas')}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <section class="card"><h3>Recebimentos por forma</h3>${table(paymentRows, ['Forma', 'Valor'], (r) => [badge(r.method), money(r.amount)])}</section>
      <section class="card"><h3>Contas abertas</h3>${table(payables.slice(0, 20), ['Vencimento', 'Descrição', 'Fornecedor', 'Valor'], (i) => [dateBR(i.dueDate), sanitize(i.description), sanitize(getSupplier(i.supplierId)?.name || '-'), money(i.value)])}</section>
    </div>
    <section class="card" style="margin-top:16px">
      <h3>Despesas</h3>
      <p class="kpi-note">Somente as despesas pagas são abatidas do lucro estimado. As pendentes aparecem no controle de contas abertas.</p>
      ${table(expenseRows, ['Data', 'Descrição', 'Categoria', 'Fornecedor', 'Valor total', 'Pago', 'Em aberto'], (e) => {
        const paid = (e.installments || []).filter((i) => i.status === 'pago').reduce((sum, i) => sum + Number(i.value || 0), 0);
        const open = (e.installments || []).filter((i) => i.status !== 'pago').reduce((sum, i) => sum + Number(i.value || 0), 0);
        return [dateBR(e.date), sanitize(e.description), badge(e.category), sanitize(getSupplier(e.supplierId)?.name || '-'), money(e.total), money(paid), money(open)];
      })}
    </section>
    <section class="card" style="margin-top:16px">
      <h3>Compras de estoque pendentes</h3>
      ${table(openStockPayables(), ['Produto', 'IMEI', 'Fornecedor', 'Vencimento', 'Valor a pagar'], (p) => [sanitize(p.name), sanitize(p.imei || '-'), sanitize(p.supplierName || '-'), p.purchaseDueDate ? dateBR(p.purchaseDueDate) : '-', money(p.payableTotal || p.purchaseTotal)])}
    </section>
    <section class="card" style="margin-top:16px"><h3>Produtos recebidos em troca</h3>${table(tradeStock, ['Produto', 'IMEI', 'Fornecedor', 'Qtd.', 'Custo/valor abatido', 'Preço venda', 'Status'], (p) => [sanitize(p.name), sanitize(p.imei || '-'), sanitize(getSupplier(p.supplierId)?.name || '-'), Number(p.qty || 0), money(p.cost), money(p.price), badge(p.status)])}</section>
    <section class="card" style="margin-top:16px">
      <h3>Exportações rápidas</h3>
      <div class="actions">
        <button class="secondary" onclick="exportCsv('produtos')">CSV produtos</button>
        <button class="secondary" onclick="exportCsv('vendas')">CSV vendas</button>
        <button class="secondary" onclick="exportCsv('despesas')">CSV despesas</button>
      </div>
    </section>
  `;
}

function renderBackup() {
  const cloud = getCloudSettings();
  $('view').innerHTML = `
    <section class="card stack">
      <h3>Banco de dados / sincronização automática</h3>
      <p>Este app já vem conectado ao banco da JP Store. Depois do login, cada venda, despesa, produto ou cliente salvo é enviado ao Supabase e os outros dispositivos recebem a alteração automaticamente.</p>
      <div class="grid cols-3">
        ${metric('Banco', 'Supabase', 'Configuração padrão do sistema')}
        ${metric('Loja', sanitize(cloud.rowId || CLOUD_DEFAULT_ROW), 'Base compartilhada entre dispositivos')}
        ${metric('Tempo real', cloud.autoSync !== false ? 'Ativo' : 'Manual', 'Atualização automática entre usuários')}
      </div>
      <div class="actions">
        <button class="secondary" type="button" id="pushCloudBtn">Enviar meus dados para o banco</button>
        <button class="secondary" type="button" id="pullCloudBtn">Baixar dados do banco</button>
        <button class="secondary" type="button" id="syncNowBtn">Sincronizar agora</button>
      </div>
      <p class="footer-note"><b>Status:</b> ${sanitize(cloud.lastSyncStatus || 'Não sincronizado ainda.')} ${cloud.lastSync ? `Última sincronização: ${new Date(cloud.lastSync).toLocaleString('pt-BR')}` : ''} ${cloud.lastRemoteUpdate ? `| Última alteração no banco: ${new Date(cloud.lastRemoteUpdate).toLocaleString('pt-BR')}` : ''} ${cloud.pendingUpload ? '| Envio pendente' : ''}</p>
    </section>

    <section class="card stack" style="margin-top:16px">
      <h3>SQL de produção para o Supabase</h3>
      <p>Execute este SQL depois de criar o usuário em <b>Authentication &gt; Users</b>. Ele troca o acesso antigo anônimo por acesso autenticado com RLS.</p>
      <pre class="code-block">-- 1) Antes de executar, crie no Supabase Auth um usuário com o e-mail:
-- jpstore@jpstore.local
-- e a senha definida para a loja.

create table if not exists public.jpstore_app_state (
  id text primary key,
  owner_id uuid default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.jpstore_app_state add column if not exists owner_id uuid default auth.uid();

update public.jpstore_app_state
set owner_id = (
  select id from auth.users where email = 'jpstore@jpstore.local' limit 1
)
where id = 'jpstore'
  and owner_id is null;

alter table public.jpstore_app_state enable row level security;

drop policy if exists "jpstore_select" on public.jpstore_app_state;
drop policy if exists "jpstore_insert" on public.jpstore_app_state;
drop policy if exists "jpstore_update" on public.jpstore_app_state;
drop policy if exists "jpstore_delete" on public.jpstore_app_state;
drop policy if exists "jpstore_auth_select" on public.jpstore_app_state;
drop policy if exists "jpstore_auth_insert" on public.jpstore_app_state;
drop policy if exists "jpstore_auth_update" on public.jpstore_app_state;

create policy "jpstore_auth_select"
on public.jpstore_app_state
for select
to authenticated
using (id = 'jpstore' and owner_id = (select auth.uid()));

create policy "jpstore_auth_insert"
on public.jpstore_app_state
for insert
to authenticated
with check (id = 'jpstore' and owner_id = (select auth.uid()));

create policy "jpstore_auth_update"
on public.jpstore_app_state
for update
to authenticated
using (id = 'jpstore' and owner_id = (select auth.uid()))
with check (id = 'jpstore' and owner_id = (select auth.uid()));

-- Ativa a tabela para receber atualizações em tempo real no aplicativo.
do $$
begin
  alter publication supabase_realtime add table public.jpstore_app_state;
exception
  when duplicate_object then null;
end $$;</pre>
      <p class="footer-note"><b>Importante:</b> a chave pública do Supabase é usada pelo navegador, mas os dados ficam protegidos pelo login do Supabase Auth e pelas políticas RLS acima. Nunca coloque chave secret/service_role no site.</p>
    </section>

    <section class="card stack" style="margin-top:16px">
      <h3>Backup dos dados</h3>
      <p>Mesmo usando banco de dados, continue fazendo backup em JSON antes de alterações grandes.</p>
      <div class="actions">
        <button class="primary" onclick="exportBackup()">Exportar backup JSON</button>
        <label class="secondary" style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:12px;padding:11px 14px;font-weight:800;">
          Importar backup
          <input id="importBackup" type="file" accept="application/json" style="display:none" />
        </label>
        <button class="danger" onclick="clearAllData()">Limpar dados locais</button>
      </div>
    </section>
  `;
  $('importBackup').addEventListener('change', importBackup);
  $('pushCloudBtn').addEventListener('click', () => pushStateToCloud({ silent: false }));
  $('pullCloudBtn').addEventListener('click', () => pullStateFromCloud({ confirm: true }));
  $('syncNowBtn').addEventListener('click', async () => {
    const pulled = await loadLatestCloudState({ silent: false, force: false, pushIfEmpty: true, renderIfPossible: true });
    if (!pulled) await pushStateToCloud({ silent: false });
  });
}


function saveCloudConfig(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  state.settings = state.settings || defaultState().settings;
  state.settings.cloud = {
    ...getCloudSettings(),
    enabled: form.get('enabled') === 'true',
    supabaseUrl: String(form.get('supabaseUrl') || '').trim(),
    supabaseAnonKey: String(form.get('supabaseAnonKey') || '').trim(),
    rowId: String(form.get('rowId') || CLOUD_DEFAULT_ROW).trim() || CLOUD_DEFAULT_ROW,
    autoSync: form.get('autoSync') !== 'false',
    lastSyncStatus: 'Configuração salva.'
  };
  stopCloudRealtime();
  cloudClient = null;
  saveState({ skipCloud: true });
  alertMsg('Configuração do banco salva.');
  if (isCloudConfigured()) {
    if (getCloudSettings().autoSync !== false) startCloudRealtime();
    else loadLatestCloudState({ silent: true, pushIfEmpty: false, renderIfPossible: true });
  }
  renderBackup();
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `backup-controle-celulares-${today()}.json`);
}

function importBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!imported.products || !imported.sales) throw new Error('Arquivo inválido.');
      if (!confirm('Importar este backup irá substituir os dados atuais. Continuar?')) return;
      state = mergeCloudState(imported);
      saveState();
      alertMsg('Backup importado com sucesso.');
      render();
    } catch (e) {
      alert('Não foi possível importar o backup. Verifique o arquivo.');
    }
  };
  reader.readAsText(file);
}

window.clearAllData = () => {
  if (!confirm('Tem certeza que deseja apagar tudo? Faça backup antes.')) return;
  if (!confirm('Confirme novamente: apagar todos os produtos, clientes, vendas e despesas?')) return;
  const cloud = getCloudSettings();
  state = defaultState();
  state.settings.cloud = cloud;
  saveState();
  render();
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

window.exportBackup = exportBackup;

window.exportCsv = (kind) => {
  let rows = [];
  if (kind === 'produtos') {
    rows = [['nome', 'tipo', 'imei', 'fornecedor', 'data_compra', 'quantidade', 'custo_unitario', 'valor_debitado_caixa', 'valor_a_pagar_fornecedor', 'pagamento_fornecedor', 'vencimento_fornecedor', 'preco_venda', 'origem', 'status'], ...state.products.map((p) => [p.name, p.type, p.imei, getSupplier(p.supplierId)?.name || '', p.purchaseDate || '', p.qty, p.cost, productPurchaseTotal(p), productPayableTotal(p), p.purchasePaymentStatus || 'pago', p.purchaseDueDate || '', p.price, p.source, p.status])];
  }
  if (kind === 'vendas') {
    rows = [['data', 'cliente', 'total', 'troca_estoque', 'caixa', 'lucro_bruto', 'dias_garantia', 'itens'], ...state.sales.map((s) => [s.date, getClient(s.customerId)?.name || '', s.total, s.tradeCredit, saleCashReceived(s), s.profit, s.warrantyDays ?? 90, s.items.map((i) => `${i.qty}x ${i.name}`).join(' | ')])];
  }
  if (kind === 'despesas') {
    rows = [['data', 'descricao', 'categoria', 'fornecedor', 'valor_total', 'parcelas_abertas'], ...state.expenses.map((e) => [e.date, e.description, e.category, getSupplier(e.supplierId)?.name || '', e.total, e.installments.filter((i) => i.status !== 'pago').length])];
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${kind}-${today()}.csv`);
};

init();
