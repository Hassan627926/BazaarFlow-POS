import React, { useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  BarChart3,
  Barcode,
  ChevronDown,
  LogOut,
  Menu,
  Moon,
  Package,
  Plus,
  Receipt,
  Settings,
  ShoppingCart,
  Store,
  Sun,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import {
  type AppTab,
  type PrintJob,
  type Product,
  type Sale,
  type StockLog,
  type StoreConfig,
} from './types';
import {
  generateSafeId,
  RESTAURANT_STARTER_PRODUCTS,
  RETAIL_STARTER_PRODUCTS,
} from './utils/posHelpers';
import { AnalyticsView } from './components/AnalyticsView';
import { AuthScreen } from './components/AuthScreen';
import { BarcodeStudioView } from './components/BarcodeStudioView';
import { BillingView } from './components/BillingView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { InventoryView } from './components/InventoryView';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PrintModal } from './components/PrintModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { SalesHistoryView } from './components/SalesHistoryView';
import { SettingsView } from './components/SettingsView';
import { StoreOnboardingModal, type NewStorePayload } from './components/StoreOnboardingModal';

function POSWorkspace() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [stores, setStores] = useState<StoreConfig[]>([]);
  const [storesLoaded, setStoresLoaded] = useState(false);
  const [activeStoreId, setActiveStoreId] = useState<string | null>(null);
  const [storeMenuOpen, setStoreMenuOpen] = useState(false);
  const [createStoreOpen, setCreateStoreOpen] = useState(false);

  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [stockLogs, setStockLogs] = useState<StockLog[]>([]);

  const [activeTab, setActiveTab] = useState<AppTab>('billing');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [printJob, setPrintJob] = useState<PrintJob | null>(null);

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('bazaarflow_theme') === 'dark';
  });

  // Sync dark mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      window.localStorage.setItem('bazaarflow_theme', 'dark');
    } else {
      root.classList.remove('dark');
      window.localStorage.setItem('bazaarflow_theme', 'light');
    }
  }, [darkMode]);

  // Listen to Firebase Auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setStores([]);
        setStoresLoaded(false);
        setActiveStoreId(null);
        setProducts([]);
        setSales([]);
        setStockLogs([]);
      }
    });
    return () => unsub();
  }, []);

  // Subscribe to owner's stores
  useEffect(() => {
    if (!authReady || !user) return;
    const storesQuery = query(collection(db, 'stores'), where('ownerId', '==', user.uid));
    const unsub = onSnapshot(
      storesQuery,
      (snap) => {
        const list: StoreConfig[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<StoreConfig, 'id'>),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setStores(list);
        setStoresLoaded(true);

        const savedId = window.localStorage.getItem('bazaarflow_active_store');
        setActiveStoreId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          if (savedId && list.some((s) => s.id === savedId)) return savedId;
          return list[0]?.id ?? null;
        });
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, 'stores');
      }
    );
    return () => unsub();
  }, [authReady, user]);

  const activeStore = useMemo(
    () => stores.find((s) => s.id === activeStoreId) ?? null,
    [stores, activeStoreId]
  );

  // Persist selected store and apply dynamic Brand CSS custom properties
  useEffect(() => {
    if (!activeStore) return;
    window.localStorage.setItem('bazaarflow_active_store', activeStore.id);
    document.documentElement.style.setProperty('--brand-primary', activeStore.primaryColor);
    document.documentElement.style.setProperty('--brand-accent', activeStore.accentColor);

    // Ensure Restaurant stores never stay on the Retail-only Barcode tab
    if (activeStore.businessType === 'restaurant' && activeTab === 'barcodes') {
      setActiveTab('billing');
    }
  }, [activeStore, activeTab]);

  // Subscribe to active store's products, sales, and stockLogs
  useEffect(() => {
    if (!user || !activeStoreId) {
      setProducts([]);
      setSales([]);
      setStockLogs([]);
      return;
    }

    const productsPath = `stores/${activeStoreId}/products`;
    const salesPath = `stores/${activeStoreId}/sales`;
    const logsPath = `stores/${activeStoreId}/stockLogs`;

    const unsubProducts = onSnapshot(
      query(collection(db, productsPath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: Product[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Product, 'id'>),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setProducts(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, productsPath)
    );

    const unsubSales = onSnapshot(
      query(collection(db, salesPath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: Sale[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Sale, 'id'>),
        }));
        list.sort((a, b) => {
          const tA = a.createdAt?.toMillis?.() ?? 0;
          const tB = b.createdAt?.toMillis?.() ?? 0;
          return tB - tA;
        });
        setSales(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, salesPath)
    );

    const unsubLogs = onSnapshot(
      query(collection(db, logsPath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: StockLog[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<StockLog, 'id'>),
        }));
        list.sort((a, b) => {
          const tA = a.createdAt?.toMillis?.() ?? 0;
          const tB = b.createdAt?.toMillis?.() ?? 0;
          return tB - tA;
        });
        setStockLogs(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, logsPath)
    );

    return () => {
      unsubProducts();
      unsubSales();
      unsubLogs();
    };
  }, [user, activeStoreId]);

  const handleCreateStore = async (payload: NewStorePayload) => {
    if (!user) return;
    const storeId = generateSafeId('store');
    const storePath = `stores/${storeId}`;

    try {
      await setDoc(doc(db, 'stores', storeId), {
        ownerId: user.uid,
        name: payload.name,
        businessType: payload.businessType,
        logoDataUrl: '',
        primaryColor: payload.primaryColor,
        accentColor: payload.accentColor,
        currency: payload.currency,
        taxRate: payload.taxRate,
        address: payload.address,
        phone: payload.phone,
        receiptFooter: 'Thank you for your business!',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (payload.seedStarterCatalog) {
        const templates =
          payload.businessType === 'retail'
            ? RETAIL_STARTER_PRODUCTS
            : RESTAURANT_STARTER_PRODUCTS;
        const batch = writeBatch(db);
        for (const item of templates) {
          const prodId = generateSafeId('prod');
          batch.set(doc(db, 'stores', storeId, 'products', prodId), {
            ownerId: user.uid,
            storeId,
            name: item.name,
            sku: item.sku,
            barcode: payload.businessType === 'retail' ? item.barcode : '',
            category: item.category,
            costPrice: item.costPrice,
            sellingPrice: item.sellingPrice,
            stock: item.stock,
            minStock: item.minStock,
            unit: item.unit,
            active: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }

      setActiveStoreId(storeId);
      setActiveTab('billing');
      setCreateStoreOpen(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, storePath);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="text-sm text-slate-500 dark:text-slate-400">Loading BazaarFlow POS...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <AuthScreen />
        <OfflineIndicator />
      </>
    );
  }

  const isRetail = activeStore?.businessType === 'retail';

  const navItems: { id: AppTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'billing', label: 'POS Billing', icon: ShoppingCart },
    { id: 'inventory', label: 'Inventory & Stock', icon: Package },
    ...(isRetail ? [{ id: 'barcodes' as const, label: 'Barcode Labels', icon: Barcode }] : []),
    { id: 'sales', label: 'Sales & Bills', icon: Receipt },
    { id: 'analytics', label: 'Owner Analytics', icon: BarChart3 },
    { id: 'settings', label: 'Brand Settings', icon: Settings },
  ];

  const currentTabLabel = navItems.find((n) => n.id === activeTab)?.label ?? 'POS Billing';

  const renderSidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Brand Workspace Switcher */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 relative">
        <button
          type="button"
          onClick={() => setStoreMenuOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-display font-bold text-xs overflow-hidden shrink-0"
              style={{ backgroundColor: activeStore?.primaryColor ?? '#0F766E' }}
            >
              {activeStore?.logoDataUrl ? (
                <img
                  src={activeStore.logoDataUrl}
                  alt={activeStore.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain bg-white p-0.5"
                />
              ) : (
                (activeStore?.name?.slice(0, 2).toUpperCase() ?? 'BF')
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold font-display text-slate-900 dark:text-slate-100 truncate">
                {activeStore?.name ?? 'Select Store'}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {activeStore?.businessType === 'restaurant' ? 'Restaurant Mode' : 'Retail Shop Mode'}
              </div>
            </div>
          </div>
          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
        </button>

        {storeMenuOpen && (
          <div className="absolute left-4 right-4 top-[74px] z-30 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl py-1.5">
            <div className="px-3 py-1 text-[11px] font-medium text-slate-400">Your Brands & Outlets</div>
            <div className="max-h-52 overflow-y-auto">
              {stores.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setActiveStoreId(s.id);
                    setStoreMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer ${
                    s.id === activeStoreId
                      ? 'font-semibold text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-800/70'
                      : 'text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    {s.businessType === 'retail' ? (
                      <Store className="w-3.5 h-3.5 shrink-0" />
                    ) : (
                      <UtensilsCrossed className="w-3.5 h-3.5 shrink-0" />
                    )}
                    <span className="truncate">{s.name}</span>
                  </span>
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: s.primaryColor }}
                  />
                </button>
              ))}
            </div>
            <div className="border-t border-slate-200 dark:border-slate-800 mt-1 pt-1 px-1.5">
              <button
                type="button"
                onClick={() => {
                  setStoreMenuOpen(false);
                  setCreateStoreOpen(true);
                }}
                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold brand-text hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add New Brand / Outlet</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Primary Workspace Navigation */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="POS sections">
        {navItems.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setActiveTab(id);
                setMobileNavOpen(false);
              }}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                active
                  ? 'brand-soft-bg brand-text font-semibold'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom Controls */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
        <div className="flex items-center gap-2">
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={() => setDarkMode((v) => !v)}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Toggle color theme"
          >
            {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            <span>{darkMode ? 'Light' : 'Dark'}</span>
          </button>
        </div>

        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
              {user.displayName || 'Store Owner'}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {user.email}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void signOut(auth)}
            className="rounded-lg p-2 text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 sticky top-0 h-screen no-print">
        {renderSidebarContent()}
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileNavOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-slate-950/60 flex no-print">
          <div className="w-72 max-w-[85vw] bg-white dark:bg-slate-900 h-full shadow-2xl relative">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              className="absolute right-3 top-3 rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 z-10"
              aria-label="Close menu"
            >
              <X className="w-4 h-4" />
            </button>
            {renderSidebarContent()}
          </div>
          <div className="flex-1" onClick={() => setMobileNavOpen(false)} />
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-20 h-14 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs px-4 sm:px-6 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden rounded-lg p-2 -ml-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="font-semibold font-display text-slate-900 dark:text-slate-100 truncate">
                {activeStore?.name ?? 'BazaarFlow POS'}
              </span>
              <span className="text-slate-300 dark:text-slate-700">/</span>
              <span className="text-slate-600 dark:text-slate-400 truncate">{currentTabLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setCreateStoreOpen(true)}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Brand</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-[1600px] w-full mx-auto no-print">
          {!storesLoaded ? (
            <div className="py-16 text-center text-sm text-slate-500 dark:text-slate-400">
              Loading your workspaces...
            </div>
          ) : !activeStore ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center max-w-lg mx-auto mt-10 space-y-4">
              <h2 className="text-xl font-bold font-display text-slate-900 dark:text-slate-100">
                Set up your first shop or restaurant
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Create a workspace with your brand name, currency, theme colors, and retail barcode or restaurant dining mode.
              </p>
              <button
                type="button"
                onClick={() => setCreateStoreOpen(true)}
                className="rounded-lg brand-bg px-5 py-2.5 text-sm font-semibold text-white cursor-pointer"
              >
                Create Brand Workspace
              </button>
            </div>
          ) : (
            <>
              {activeTab === 'billing' && (
                <BillingView
                  store={activeStore}
                  products={products}
                  ownerId={user.uid}
                  onPrintJob={setPrintJob}
                  onGoToInventory={() => setActiveTab('inventory')}
                />
              )}
              {activeTab === 'inventory' && (
                <InventoryView
                  store={activeStore}
                  products={products}
                  stockLogs={stockLogs}
                  ownerId={user.uid}
                />
              )}
              {activeTab === 'barcodes' && isRetail && (
                <BarcodeStudioView
                  store={activeStore}
                  products={products}
                  onPrintJob={setPrintJob}
                />
              )}
              {activeTab === 'sales' && (
                <SalesHistoryView
                  store={activeStore}
                  sales={sales}
                  products={products}
                  ownerId={user.uid}
                  onPrintJob={setPrintJob}
                />
              )}
              {activeTab === 'analytics' && (
                <AnalyticsView
                  store={activeStore}
                  sales={sales}
                  products={products}
                  onPrintJob={setPrintJob}
                />
              )}
              {activeTab === 'settings' && (
                <SettingsView
                  store={activeStore}
                  darkMode={darkMode}
                  onToggleDarkMode={() => setDarkMode((v) => !v)}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* Onboarding Modal (auto-opens if signed-in owner has zero stores) */}
      <StoreOnboardingModal
        isOpen={createStoreOpen || (storesLoaded && stores.length === 0)}
        canClose={stores.length > 0}
        onClose={() => setCreateStoreOpen(false)}
        onCreate={handleCreateStore}
      />

      {/* Unified Thermal Receipt, KOT, Barcode Sheet & Daily Z-Report Printer */}
      {activeStore && (
        <PrintModal job={printJob} store={activeStore} onClose={() => setPrintJob(null)} />
      )}

      <OfflineIndicator />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <POSWorkspace />
    </ErrorBoundary>
  );
}
