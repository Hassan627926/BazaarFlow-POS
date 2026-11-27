import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getRedirectResult, onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  Banknote,
  BarChart3,
  Barcode,
  Bell,
  ChevronDown,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  Package,
  Plus,
  Printer,
  Receipt,
  Settings,
  ShoppingCart,
  Smartphone,
  Store,
  Sun,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import {
  type AppTab,
  type Customer,
  type Employee,
  type KotKitchenStatus,
  type KotTicket,
  type PrintJob,
  type Product,
  type Sale,
  type StockLog,
  type StoreConfig,
  type TableSession,
  type WaiterAccess,
} from './types';
import {
  formatMoney,
  formatSalePaymentLabel,
  generateSafeId,
  getTodayDateKey,
  RESTAURANT_STARTER_PRODUCTS,
  RETAIL_STARTER_PRODUCTS,
} from './utils/posHelpers';
import {
  initKitchenAudioUnlock,
  playBillClearedChime,
  playKitchenBellChime,
  playOrderReadyChime,
  triggerReadyVibration,
} from './utils/soundAlert';
import { AnalyticsView } from './components/AnalyticsView';
import { AuthScreen } from './components/AuthScreen';
import { BarcodeStudioView } from './components/BarcodeStudioView';
import { BillingView } from './components/BillingView';
import { EmployeesView } from './components/EmployeesView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { InventoryView } from './components/InventoryView';
import { KitchenKotQueueView } from './components/KitchenKotQueueView';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PasswordSetupModal } from './components/PasswordSetupModal';
import { PrintModal } from './components/PrintModal';
import { PWAInstallButton } from './components/PWAInstallButton';
import { SalesHistoryView } from './components/SalesHistoryView';
import { SettingsView } from './components/SettingsView';
import { StoreOnboardingModal, type NewStorePayload } from './components/StoreOnboardingModal';
import { WaiterOrderView } from './components/WaiterOrderView';

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
  const [tableSessions, setTableSessions] = useState<TableSession[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [kotTickets, setKotTickets] = useState<KotTicket[]>([]);

  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('station') === 'kot') {
      return 'kot_queue';
    }
    return 'billing';
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [printJob, setPrintJob] = useState<PrintJob | null>(null);
  const [boundaryError, setBoundaryError] = useState<Error | null>(null);

  // Live Kitchen KOT Sound & Window-Scoped Auto-Print Station state
  const [kotSoundEnabled, setKotSoundEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem('bazaarflow_kot_sound');
    return saved === null ? true : saved === '1';
  });
  const [kotAutoPrint, setKotAutoPrint] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(window.location.search).get('station') === 'kot') return true;
    return window.sessionStorage.getItem('bazaarflow_kot_autoprint') === '1';
  });
  const kotSoundEnabledRef = useRef(kotSoundEnabled);
  const kotHydratedRef = useRef(false);
  const seenPendingKotIdsRef = useRef<Set<string>>(new Set());
  const ownerReadyHydratedRef = useRef(false);
  const seenOwnerReadyKotIdsRef = useRef<Set<string>>(new Set());
  const autoDispatchedKotIdsRef = useRef<Set<string>>(new Set());
  const salesHydratedRef = useRef(false);
  const seenWaiterBillIdsRef = useRef<Set<string>>(new Set());
  const [recentWaiterBills, setRecentWaiterBills] = useState<Sale[]>([]);
  const activeTabRef = useRef<AppTab>(activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    initKitchenAudioUnlock();
  }, []);

  useEffect(() => {
    kotSoundEnabledRef.current = kotSoundEnabled;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('bazaarflow_kot_sound', kotSoundEnabled ? '1' : '0');
    }
  }, [kotSoundEnabled]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('bazaarflow_kot_autoprint', kotAutoPrint ? '1' : '0');
    }
    if (!kotAutoPrint) {
      autoDispatchedKotIdsRef.current.clear();
    }
  }, [kotAutoPrint]);

  // Waiter Mobile App access state
  const [preferWaiterMode, setPreferWaiterMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(window.location.search).get('mode') === 'waiter') return true;
    return window.sessionStorage.getItem('bazaarflow_login_mode') === 'waiter';
  });
  const [waiterGrants, setWaiterGrants] = useState<WaiterAccess[]>([]);
  const [waiterGrantsLoaded, setWaiterGrantsLoaded] = useState(false);
  const [waiterMemberReady, setWaiterMemberReady] = useState(false);
  const [waiterSyncError, setWaiterSyncError] = useState<string | null>(null);
  const [waiterStore, setWaiterStore] = useState<StoreConfig | null>(null);
  const [waiterProducts, setWaiterProducts] = useState<Product[]>([]);
  const [waiterTables, setWaiterTables] = useState<TableSession[]>([]);
  const [waiterKotTickets, setWaiterKotTickets] = useState<KotTicket[]>([]);
  const waiterKotHydratedRef = useRef(false);
  const seenWaiterReadyKotIdsRef = useRef<Set<string>>(new Set());

  // Post-sign-in Create/Change Password modal state
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordLinkedTick, setPasswordLinkedTick] = useState(0);

  const hasPasswordProvider = useMemo(() => {
    void passwordLinkedTick;
    const activeUser = auth.currentUser ?? user;
    if (!activeUser) return false;
    return activeUser.providerData.some((p) => p.providerId === 'password');
  }, [user, passwordLinkedTick]);

  const onboardingRequired = Boolean(
    createStoreOpen ||
      (storesLoaded &&
        waiterGrantsLoaded &&
        stores.length === 0 &&
        !waiterGrants.some((g) => g.active) &&
        !preferWaiterMode)
  );

  // Prompt user right after sign-in to create a password if they haven't linked Email/Password yet
  useEffect(() => {
    if (!authReady || !user || !user.email || !storesLoaded || !waiterGrantsLoaded) return;
    if (hasPasswordProvider || onboardingRequired) return;
    if (preferWaiterMode && !waiterGrants.some((g) => g.active)) return;
    const dismissKey = `bazaarflow_pwd_prompt_dismissed_${user.uid}`;
    if (typeof window !== 'undefined' && window.sessionStorage.getItem(dismissKey) === '1') {
      return;
    }
    setPasswordModalOpen(true);
  }, [
    authReady,
    user,
    storesLoaded,
    waiterGrantsLoaded,
    hasPasswordProvider,
    onboardingRequired,
    preferWaiterMode,
    waiterGrants,
  ]);

  const handleClosePasswordModal = () => {
    if (user && typeof window !== 'undefined') {
      window.sessionStorage.setItem(`bazaarflow_pwd_prompt_dismissed_${user.uid}`, '1');
    }
    setPasswordModalOpen(false);
  };

  const reportSnapshotError = (err: unknown, op: OperationType, path: string) => {
    try {
      handleFirestoreError(err, op, path);
    } catch (wrapped) {
      setBoundaryError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
    }
  };

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

  // Listen to Firebase Auth (and recover any pending redirect sign-in)
  useEffect(() => {
    void getRedirectResult(auth)
      .then((res) => {
        if (res?.user) {
          setUser(res.user);
        }
      })
      .catch(() => {
        // Handled via normal auth state listener
      });

    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser) {
        if (typeof window !== 'undefined') {
          const urlWaiter = new URLSearchParams(window.location.search).get('mode') === 'waiter';
          const storedWaiter = window.sessionStorage.getItem('bazaarflow_login_mode') === 'waiter';
          setPreferWaiterMode(urlWaiter || storedWaiter);
        }
      } else {
        setStores([]);
        setStoresLoaded(false);
        setActiveStoreId(null);
        setProducts([]);
        setSales([]);
        setStockLogs([]);
        setTableSessions([]);
        setCustomers([]);
        setEmployees([]);
        setKotTickets([]);
        setRecentWaiterBills([]);
        kotHydratedRef.current = false;
        seenPendingKotIdsRef.current.clear();
        ownerReadyHydratedRef.current = false;
        seenOwnerReadyKotIdsRef.current.clear();
        autoDispatchedKotIdsRef.current.clear();
        salesHydratedRef.current = false;
        seenWaiterBillIdsRef.current.clear();
        setWaiterGrants([]);
        setWaiterGrantsLoaded(false);
        setWaiterMemberReady(false);
        setWaiterSyncError(null);
        setWaiterStore(null);
        setWaiterProducts([]);
        setWaiterTables([]);
        setWaiterKotTickets([]);
        waiterKotHydratedRef.current = false;
        seenWaiterReadyKotIdsRef.current.clear();
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
        reportSnapshotError(err, OperationType.LIST, 'stores');
      }
    );
    return () => unsub();
  }, [authReady, user]);

  // Subscribe to any Waiter Mobile Access grants assigned to this signed-in Google email
  useEffect(() => {
    if (!authReady || !user) return;
    const emailLower = user.email?.trim().toLowerCase() ?? '';
    if (!emailLower) {
      setWaiterGrants([]);
      setWaiterGrantsLoaded(true);
      return;
    }

    const grantsQuery = query(
      collection(db, 'waiterAccess'),
      where('waiterEmail', '==', emailLower)
    );
    const unsub = onSnapshot(
      grantsQuery,
      (snap) => {
        const list: WaiterAccess[] = snap.docs
          .map((d) => ({
            id: d.id,
            ...(d.data() as Omit<WaiterAccess, 'id'>),
          }))
          .filter((g) => g.active);
        setWaiterGrants(list);
        setWaiterGrantsLoaded(true);
      },
      () => {
        setWaiterGrants([]);
        setWaiterGrantsLoaded(true);
      }
    );
    return () => unsub();
  }, [authReady, user]);

  const activeWaiterGrant = useMemo(
    () => waiterGrants.find((g) => g.active) ?? null,
    [waiterGrants]
  );

  const isStandaloneWaiterMode = useMemo(() => {
    if (!activeWaiterGrant) return false;
    if (preferWaiterMode) return true;
    return storesLoaded && stores.length === 0;
  }, [activeWaiterGrant, preferWaiterMode, storesLoaded, stores.length]);

  // Bind /stores/{storeId}/waiterMembers/{user.uid} when entering standalone Waiter Mobile App
  useEffect(() => {
    if (!isStandaloneWaiterMode || !user || !user.email || !activeWaiterGrant) {
      setWaiterMemberReady(false);
      setWaiterSyncError(null);
      return;
    }

    let cancelled = false;
    setWaiterMemberReady(false);
    setWaiterSyncError(null);

    const bindMember = async () => {
      const storeId = activeWaiterGrant.storeId;
      const memberRef = doc(db, 'stores', storeId, 'waiterMembers', user.uid);
      const emailLower = user.email!.trim().toLowerCase();
      try {
        const snap = await getDoc(memberRef);
        if (snap.exists()) {
          const data = snap.data();
          const alreadySynced =
            data?.active === true &&
            data?.accessId === activeWaiterGrant.id &&
            data?.employeeId === activeWaiterGrant.employeeId &&
            data?.waiterEmail === emailLower;
          if (!alreadySynced) {
            await updateDoc(memberRef, {
              accessId: activeWaiterGrant.id,
              employeeId: activeWaiterGrant.employeeId,
              employeeName: activeWaiterGrant.employeeName,
              waiterEmail: emailLower,
              active: true,
              updatedAt: serverTimestamp(),
            });
          }
        } else {
          await setDoc(memberRef, {
            ownerId: activeWaiterGrant.ownerId,
            storeId,
            accessId: activeWaiterGrant.id,
            employeeId: activeWaiterGrant.employeeId,
            employeeName: activeWaiterGrant.employeeName,
            waiterUid: user.uid,
            waiterEmail: emailLower,
            active: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        if (!cancelled) {
          setWaiterMemberReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          const rawMsg =
            err instanceof Error ? err.message : 'Unable to activate waiter mobile session.';
          setWaiterSyncError(
            rawMsg.toLowerCase().includes('permission')
              ? 'First-time waiter activation requires Google Sign-In once (or ask your restaurant owner to create your Waiter Account directly inside Owner POS → Employees / Staff).'
              : rawMsg
          );
        }
      }
    };

    void bindMember();
    return () => {
      cancelled = true;
    };
  }, [isStandaloneWaiterMode, user, activeWaiterGrant]);

  // Subscribe to store, menu products, live tables, and kitchen KOT status in standalone Waiter Mobile Mode
  useEffect(() => {
    if (!isStandaloneWaiterMode || !waiterMemberReady || !activeWaiterGrant) {
      setWaiterStore(null);
      setWaiterProducts([]);
      setWaiterTables([]);
      setWaiterKotTickets([]);
      waiterKotHydratedRef.current = false;
      seenWaiterReadyKotIdsRef.current.clear();
      return;
    }

    const storeId = activeWaiterGrant.storeId;
    const productsPath = `stores/${storeId}/products`;
    const tablesPath = `stores/${storeId}/tables`;
    const kotQueuePath = `stores/${storeId}/kotQueue`;

    waiterKotHydratedRef.current = false;
    seenWaiterReadyKotIdsRef.current.clear();

    const unsubStore = onSnapshot(
      doc(db, 'stores', storeId),
      (snap) => {
        if (snap.exists()) {
          const cfg: StoreConfig = {
            id: snap.id,
            ...(snap.data() as Omit<StoreConfig, 'id'>),
          };
          setWaiterStore(cfg);
          document.documentElement.style.setProperty('--brand-primary', cfg.primaryColor);
          document.documentElement.style.setProperty('--brand-accent', cfg.accentColor);
        } else {
          setWaiterStore(null);
        }
      },
      (err) => {
        setWaiterSyncError(
          err instanceof Error ? err.message : 'Access to restaurant workspace was revoked.'
        );
      }
    );

    const unsubProducts = onSnapshot(
      query(collection(db, productsPath), where('storeId', '==', storeId)),
      (snap) => {
        const list: Product[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Product, 'id'>),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setWaiterProducts(list);
      },
      (err) => {
        setWaiterSyncError(
          err instanceof Error ? err.message : 'Unable to load restaurant menu.'
        );
      }
    );

    const unsubTables = onSnapshot(
      query(collection(db, tablesPath), where('storeId', '==', storeId)),
      (snap) => {
        const list: TableSession[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<TableSession, 'id'>),
        }));
        list.sort((a, b) => Number(a.tableNumber) - Number(b.tableNumber));
        setWaiterTables(list);
      },
      (err) => {
        setWaiterSyncError(
          err instanceof Error ? err.message : 'Unable to load live tables.'
        );
      }
    );

    const unsubKotQueue = onSnapshot(
      query(collection(db, kotQueuePath), where('storeId', '==', storeId)),
      (snap) => {
        const list: KotTicket[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<KotTicket, 'id'>),
        }));
        setWaiterKotTickets(list);

        const readyIds = new Set(
          list
            .filter((t) => t.ticketKind !== 'reprint' && t.kitchenStatus === 'ready')
            .map((t) => t.id)
        );
        if (!waiterKotHydratedRef.current) {
          seenWaiterReadyKotIdsRef.current = readyIds;
          waiterKotHydratedRef.current = true;
        } else {
          let hasNewReady = false;
          for (const id of readyIds) {
            if (!seenWaiterReadyKotIdsRef.current.has(id)) {
              hasNewReady = true;
              break;
            }
          }
          seenWaiterReadyKotIdsRef.current = readyIds;
          if (hasNewReady) {
            if (kotSoundEnabledRef.current) {
              void playOrderReadyChime();
            }
            triggerReadyVibration();
          }
        }
      },
      () => {
        setWaiterKotTickets([]);
      }
    );

    return () => {
      unsubStore();
      unsubProducts();
      unsubTables();
      unsubKotQueue();
    };
  }, [isStandaloneWaiterMode, waiterMemberReady, activeWaiterGrant]);

  const activeStore = useMemo(
    () => stores.find((s) => s.id === activeStoreId) ?? null,
    [stores, activeStoreId]
  );

  // Persist selected store and apply dynamic Brand CSS custom properties
  useEffect(() => {
    if (!activeStore || isStandaloneWaiterMode) return;
    window.localStorage.setItem('bazaarflow_active_store', activeStore.id);
    document.documentElement.style.setProperty('--brand-primary', activeStore.primaryColor);
    document.documentElement.style.setProperty('--brand-accent', activeStore.accentColor);

    // Ensure Restaurant stores never stay on Retail-only Barcode tab, and Retail stores never stay on Restaurant-only tabs
    if (activeStore.businessType === 'restaurant' && activeTab === 'barcodes') {
      setActiveTab('billing');
    } else if (
      activeStore.businessType === 'retail' &&
      (activeTab === 'waiter' || activeTab === 'kot_queue')
    ) {
      setActiveTab('billing');
    }
  }, [activeStore, activeTab, isStandaloneWaiterMode]);

  // Subscribe to active store's products, sales, stockLogs, tables, customers, employees, and kotQueue
  useEffect(() => {
    if (!user || !activeStoreId || isStandaloneWaiterMode) {
      setProducts([]);
      setSales([]);
      setStockLogs([]);
      setTableSessions([]);
      setCustomers([]);
      setEmployees([]);
      setKotTickets([]);
      setRecentWaiterBills([]);
      kotHydratedRef.current = false;
      seenPendingKotIdsRef.current.clear();
      ownerReadyHydratedRef.current = false;
      seenOwnerReadyKotIdsRef.current.clear();
      autoDispatchedKotIdsRef.current.clear();
      salesHydratedRef.current = false;
      seenWaiterBillIdsRef.current.clear();
      return;
    }

    kotHydratedRef.current = false;
    seenPendingKotIdsRef.current.clear();
    ownerReadyHydratedRef.current = false;
    seenOwnerReadyKotIdsRef.current.clear();
    autoDispatchedKotIdsRef.current.clear();
    salesHydratedRef.current = false;
    seenWaiterBillIdsRef.current.clear();
    setRecentWaiterBills([]);

    const productsPath = `stores/${activeStoreId}/products`;
    const salesPath = `stores/${activeStoreId}/sales`;
    const logsPath = `stores/${activeStoreId}/stockLogs`;
    const tablesPath = `stores/${activeStoreId}/tables`;
    const customersPath = `stores/${activeStoreId}/customers`;
    const employeesPath = `stores/${activeStoreId}/employees`;
    const kotQueuePath = `stores/${activeStoreId}/kotQueue`;

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
      (err) => reportSnapshotError(err, OperationType.LIST, productsPath)
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

        // Live Bell & Alert on Counter Laptop whenever a Waiter clears a Table Bill from Mobile
        const waiterBills = list.filter(
          (s) => s.settledBy === 'waiter_mobile' && s.status === 'completed'
        );
        if (!salesHydratedRef.current) {
          waiterBills.forEach((s) => seenWaiterBillIdsRef.current.add(s.id));
          salesHydratedRef.current = true;
        } else {
          const newlyCleared: Sale[] = [];
          for (const s of waiterBills) {
            if (!seenWaiterBillIdsRef.current.has(s.id)) {
              seenWaiterBillIdsRef.current.add(s.id);
              newlyCleared.push(s);
            }
          }
          if (newlyCleared.length > 0) {
            setRecentWaiterBills((prev) => [...newlyCleared, ...prev].slice(0, 10));
            if (kotSoundEnabledRef.current) {
              void playBillClearedChime();
            }
          }
        }
      },
      (err) => reportSnapshotError(err, OperationType.LIST, salesPath)
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
      (err) => reportSnapshotError(err, OperationType.LIST, logsPath)
    );

    const unsubTables = onSnapshot(
      query(collection(db, tablesPath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: TableSession[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<TableSession, 'id'>),
        }));
        list.sort((a, b) => Number(a.tableNumber) - Number(b.tableNumber));
        setTableSessions(list);
      },
      (err) => reportSnapshotError(err, OperationType.LIST, tablesPath)
    );

    const unsubCustomers = onSnapshot(
      query(collection(db, customersPath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: Customer[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Customer, 'id'>),
        }));
        setCustomers(list);
      },
      (err) => reportSnapshotError(err, OperationType.LIST, customersPath)
    );

    const unsubEmployees = onSnapshot(
      query(collection(db, employeesPath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: Employee[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Employee, 'id'>),
        }));
        list.sort((a, b) => a.name.localeCompare(b.name));
        setEmployees(list);
      },
      (err) => reportSnapshotError(err, OperationType.LIST, employeesPath)
    );

    const unsubKotQueue = onSnapshot(
      query(collection(db, kotQueuePath), where('ownerId', '==', user.uid)),
      (snap) => {
        const list: KotTicket[] = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<KotTicket, 'id'>),
        }));
        setKotTickets(list);

        const pendingList = list.filter((t) => t.status === 'pending');
        if (!kotHydratedRef.current) {
          pendingList.forEach((t) => seenPendingKotIdsRef.current.add(t.id));
          kotHydratedRef.current = true;
        } else {
          let hasNewPending = false;
          for (const t of pendingList) {
            if (!seenPendingKotIdsRef.current.has(t.id)) {
              seenPendingKotIdsRef.current.add(t.id);
              hasNewPending = true;
            }
          }
          if (hasNewPending && kotSoundEnabledRef.current) {
            void playKitchenBellChime();
          }
        }

        const ownerReadyIds = new Set(
          list
            .filter((t) => t.ticketKind !== 'reprint' && t.kitchenStatus === 'ready')
            .map((t) => t.id)
        );
        if (!ownerReadyHydratedRef.current) {
          seenOwnerReadyKotIdsRef.current = ownerReadyIds;
          ownerReadyHydratedRef.current = true;
        } else {
          let hasNewReady = false;
          for (const id of ownerReadyIds) {
            if (!seenOwnerReadyKotIdsRef.current.has(id)) {
              hasNewReady = true;
              break;
            }
          }
          seenOwnerReadyKotIdsRef.current = ownerReadyIds;
          if (hasNewReady && kotSoundEnabledRef.current && activeTabRef.current !== 'kot_queue') {
            void playOrderReadyChime();
          }
        }
      },
      (err) => reportSnapshotError(err, OperationType.LIST, kotQueuePath)
    );

    return () => {
      unsubProducts();
      unsubSales();
      unsubLogs();
      unsubTables();
      unsubCustomers();
      unsubEmployees();
      unsubKotQueue();
    };
  }, [user, activeStoreId, isStandaloneWaiterMode]);

  const pendingKotTickets = useMemo(() => {
    return kotTickets
      .filter((t) => t.status === 'pending')
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
  }, [kotTickets]);

  const readyKotTickets = useMemo(() => {
    return kotTickets.filter(
      (t) => t.ticketKind !== 'reprint' && t.kitchenStatus === 'ready'
    );
  }, [kotTickets]);

  const buildPrintJobFromKot = useCallback(
    (ticket: KotTicket, autoPrint = false): Extract<PrintJob, { type: 'kot' }> => {
      const subtotal = ticket.items.reduce((sum, i) => sum + i.lineTotal, 0);
      const totalCost = ticket.items.reduce((sum, i) => sum + i.costPrice * i.quantity, 0);
      const kotSale: Sale = {
        id: ticket.id,
        ownerId: ticket.ownerId,
        storeId: ticket.storeId,
        invoiceNumber: ticket.ticketNumber,
        dateKey: getTodayDateKey(),
        items: ticket.items,
        itemCount: ticket.itemCount,
        subtotal,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        total: subtotal,
        totalCost,
        profit: subtotal - totalCost,
        ...(typeof ticket.tokenNumber === 'number' ? { tokenNumber: ticket.tokenNumber } : {}),
        paymentMethod: 'cash',
        amountTendered: 0,
        changeDue: 0,
        orderType: ticket.orderType,
        tableNumber: ticket.tableNumber,
        customerName: ticket.customerName,
        employeeId: ticket.employeeId,
        employeeName: ticket.employeeName,
        status: 'completed',
        createdAt: ticket.createdAt ?? null,
        updatedAt: ticket.updatedAt ?? null,
      };
      return {
        type: 'kot',
        sale: kotSale,
        isAddOn: ticket.ticketKind === 'addon',
        isRevised: ticket.ticketKind === 'revised',
        changeNotes: ticket.changeNotes,
        kotId: ticket.id,
        autoPrint,
      };
    },
    []
  );

  const handleMarkKotPrinted = useCallback(
    async (kotId: string) => {
      if (!activeStoreId) return;
      const path = `stores/${activeStoreId}/kotQueue/${kotId}`;
      try {
        await updateDoc(doc(db, 'stores', activeStoreId, 'kotQueue', kotId), {
          status: 'printed',
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        reportSnapshotError(err, OperationType.UPDATE, path);
      }
    },
    [activeStoreId]
  );

  const handleUpdateKotKitchenStatus = useCallback(
    async (
      targetStoreId: string,
      kotId: string,
      nextStatus: KotKitchenStatus,
      rethrowOnError = false
    ) => {
      if (!targetStoreId || !kotId) return;
      const path = `stores/${targetStoreId}/kotQueue/${kotId}`;
      try {
        await updateDoc(doc(db, 'stores', targetStoreId, 'kotQueue', kotId), {
          kitchenStatus: nextStatus,
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        if (rethrowOnError) {
          throw err instanceof Error ? err : new Error('Unable to update kitchen order status.');
        }
        reportSnapshotError(err, OperationType.UPDATE, path);
      }
    },
    []
  );

  const handleClearPrintedKots = useCallback(async () => {
    if (!activeStoreId) return;
    const clearable = kotTickets.filter(
      (t) =>
        t.status === 'printed' &&
        (t.kitchenStatus === 'served' || t.ticketKind === 'reprint')
    );
    if (clearable.length === 0) return;
    const path = `stores/${activeStoreId}/kotQueue`;
    try {
      const batch = writeBatch(db);
      clearable.slice(0, 400).forEach((ticket) => {
        batch.delete(doc(db, 'stores', activeStoreId, 'kotQueue', ticket.id));
      });
      await batch.commit();
    } catch (err) {
      reportSnapshotError(err, OperationType.DELETE, path);
    }
  }, [activeStoreId, kotTickets]);

  const handlePrintKotTicket = useCallback(
    (ticket: KotTicket, autoPrint = false) => {
      setPrintJob(buildPrintJobFromKot(ticket, autoPrint));
    },
    [buildPrintJobFromKot]
  );

  // Auto-Print Station loop: prints pending KOTs FIFO one by one when enabled in this browser window
  useEffect(() => {
    if (
      !kotAutoPrint ||
      !activeStore ||
      activeStore.businessType !== 'restaurant' ||
      isStandaloneWaiterMode ||
      printJob
    ) {
      return;
    }
    const nextTicket = pendingKotTickets.find(
      (t) => !autoDispatchedKotIdsRef.current.has(t.id)
    );
    if (!nextTicket) return;
    autoDispatchedKotIdsRef.current.add(nextTicket.id);
    setPrintJob(buildPrintJobFromKot(nextTicket, true));
  }, [kotAutoPrint, activeStore, isStandaloneWaiterMode, printJob, pendingKotTickets, buildPrintJobFromKot]);

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
        ...(payload.businessType === 'restaurant'
          ? { serviceChargeRate: 0, defaultDeliveryFee: 0 }
          : {}),
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
            trackStock: payload.businessType === 'restaurant' ? (item.trackStock ?? false) : true,
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

  if (boundaryError) {
    throw boundaryError;
  }

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
        <AuthScreen
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((v) => !v)}
          onSignedIn={(signedInUser, mode) => {
            if (typeof window !== 'undefined') {
              window.sessionStorage.setItem('bazaarflow_login_mode', mode);
            }
            setPreferWaiterMode(mode === 'waiter');
            setUser(signedInUser);
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  // Wait for both stores and waiter grants before routing so waiters never flash the Owner onboarding modal
  if (!storesLoaded || !waiterGrantsLoaded) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Loading BazaarFlow POS...
        </div>
      </div>
    );
  }

  // Standalone Waiter Mobile App mode
  if (isStandaloneWaiterMode && activeWaiterGrant) {
    if (waiterSyncError) {
      return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4 text-center">
            <Smartphone className="w-8 h-8 mx-auto text-red-500" />
            <h2 className="text-lg font-bold font-display text-slate-900 dark:text-slate-100">
              Waiter Mobile Session Paused
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {waiterSyncError}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-center pt-1">
              {stores.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      window.sessionStorage.setItem('bazaarflow_login_mode', 'owner');
                    }
                    setPreferWaiterMode(false);
                  }}
                  className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  Switch to Owner POS
                </button>
              )}
              <button
                type="button"
                onClick={() => void signOut(auth)}
                className="rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2 text-xs font-semibold text-white dark:text-slate-900 cursor-pointer"
              >
                Sign Out
              </button>
            </div>
          </div>
          <OfflineIndicator />
        </div>
      );
    }

    if (!waiterMemberReady || !waiterStore) {
      return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
          <div className="text-center space-y-2">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Connecting to {activeWaiterGrant.storeName}...
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Loading live tables & menu for {activeWaiterGrant.employeeName}
            </div>
          </div>
        </div>
      );
    }

    return (
      <>
        <WaiterOrderView
          standalone
          store={waiterStore}
          products={waiterProducts}
          tableSessions={waiterTables}
          kotTickets={waiterKotTickets}
          waiterGrant={activeWaiterGrant}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((v) => !v)}
          onSignOut={() => void signOut(auth)}
          onSwitchToOwner={
            stores.length > 0
              ? () => {
                  if (typeof window !== 'undefined') {
                    window.sessionStorage.setItem('bazaarflow_login_mode', 'owner');
                  }
                  setPreferWaiterMode(false);
                }
              : undefined
          }
          hasPassword={hasPasswordProvider}
          onOpenPasswordSetup={() => setPasswordModalOpen(true)}
          onPrintJob={setPrintJob}
          onUpdateKitchenStatus={(kotId, nextStatus) =>
            handleUpdateKotKitchenStatus(waiterStore.id, kotId, nextStatus, true)
          }
        />
        <PasswordSetupModal
          user={user}
          isOpen={passwordModalOpen}
          hasPasswordProvider={hasPasswordProvider}
          onClose={handleClosePasswordModal}
          onPasswordSaved={() => setPasswordLinkedTick((t) => t + 1)}
        />
        <PrintModal job={printJob} store={waiterStore} onClose={() => setPrintJob(null)} />
        <OfflineIndicator />
      </>
    );
  }

  // Signed in via Waiter Mobile mode with an account that does not have active Waiter Access yet
  if (preferWaiterMode && !activeWaiterGrant) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-7 space-y-4 text-center">
          <div className="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 flex items-center justify-center mx-auto">
            <Smartphone className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold font-display text-slate-900 dark:text-slate-100">
            No Active Waiter Access Found
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            You signed in as{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
              {user.email}
            </span>
            . Waiter accounts must be created or enabled inside your restaurant owner&apos;s POS under{' '}
            <strong>Employees / Staff → Create Waiter Account</strong> using this exact email address.
          </p>
          <div className="flex flex-col gap-2 pt-2">
            <button
              type="button"
              onClick={() => void signOut(auth)}
              className="w-full rounded-lg bg-slate-900 dark:bg-slate-100 px-4 py-2.5 text-xs font-semibold text-white dark:text-slate-900 cursor-pointer"
            >
              Sign Out / Switch Account
            </button>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.sessionStorage.setItem('bazaarflow_login_mode', 'owner');
                }
                setPreferWaiterMode(false);
              }}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              {stores.length > 0
                ? 'Open My Owner Console Instead'
                : "I'm an Owner — Create Brand Workspace"}
            </button>
          </div>
        </div>
        <OfflineIndicator />
      </div>
    );
  }

  const isRetail = activeStore?.businessType === 'retail';

  const navItems: {
    id: AppTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }[] = [
    { id: 'billing', label: 'POS Billing', icon: ShoppingCart },
    ...(!isRetail && activeStore
      ? [
          { id: 'waiter' as const, label: 'Waiter Order & KOT', icon: Smartphone },
          {
            id: 'kot_queue' as const,
            label: 'Kitchen Display & KOT',
            icon: Printer,
            badge: pendingKotTickets.length + readyKotTickets.length,
          },
        ]
      : []),
    { id: 'inventory', label: 'Inventory & Stock', icon: Package },
    ...(isRetail ? [{ id: 'barcodes' as const, label: 'Barcode Labels', icon: Barcode }] : []),
    { id: 'sales', label: 'Sales & Bills', icon: Receipt },
    { id: 'employees', label: 'Employees / Staff', icon: Users },
    { id: 'analytics', label: 'Owner Analytics', icon: BarChart3 },
    { id: 'settings', label: 'Brand Settings', icon: Settings },
  ];

  const currentTabLabel = navItems.find((n) => n.id === activeTab)?.label ?? 'POS Billing';

  const renderSidebarContent = () => (
    <div className="flex flex-col h-full min-h-0">
      {/* Brand Workspace Switcher */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 relative shrink-0">
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
      <nav className="flex-1 min-h-0 p-3 space-y-1 overflow-y-auto" aria-label="POS sections">
        {navItems.map(({ id, label, icon: Icon, badge }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                setActiveTab(id);
                setMobileNavOpen(false);
              }}
              className={`w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                active
                  ? 'brand-soft-bg brand-text font-semibold'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{label}</span>
              </span>
              {typeof badge === 'number' && badge > 0 && (
                <span className="rounded-md bg-amber-500 text-white text-[11px] font-bold font-mono px-1.5 py-0.5 leading-none shrink-0">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom Controls */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2 shrink-0">
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
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setPasswordModalOpen(true);
                setMobileNavOpen(false);
              }}
              className={`rounded-lg p-2 cursor-pointer ${
                hasPasswordProvider
                  ? 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                  : 'text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40'
              }`}
              title={hasPasswordProvider ? 'Change login password' : 'Create login password'}
              aria-label={hasPasswordProvider ? 'Change login password' : 'Create login password'}
            >
              <KeyRound className="w-4 h-4" />
            </button>
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
    </div>
  );

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden print:h-auto print:overflow-visible bg-slate-50 dark:bg-slate-950 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 h-full border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 no-print">
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
      <div className="flex-1 flex flex-col min-w-0 lg:h-full lg:overflow-hidden print:h-auto print:overflow-visible">
        <header className="sticky top-0 lg:static shrink-0 z-20 h-14 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs px-4 sm:px-6 flex items-center justify-between gap-4 no-print">
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
            {!isRetail && activeStore && recentWaiterBills.length > 0 && (
              <button
                type="button"
                onClick={() => setPrintJob({ type: 'receipt', sale: recentWaiterBills[0] })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/80 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Banknote className="w-3.5 h-3.5" />
                <span>{recentWaiterBills.length} Bill Cleared</span>
              </button>
            )}
            {!isRetail && activeStore && readyKotTickets.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('kot_queue')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 px-3 py-1.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/80 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>{readyKotTickets.length} Ready to Serve</span>
              </button>
            )}
            {!isRetail && activeStore && pendingKotTickets.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('kot_queue')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/50 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/80 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>
                  {pendingKotTickets.length} KOT Pending
                </span>
              </button>
            )}
            {activeWaiterGrant && (
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    window.sessionStorage.setItem('bazaarflow_login_mode', 'waiter');
                  }
                  setPreferWaiterMode(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Waiter Mobile</span>
              </button>
            )}
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

        <main className="flex-1 lg:overflow-y-auto p-4 sm:p-6 w-full no-print">
          <div className="max-w-[1600px] w-full mx-auto">
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
              {!isRetail && recentWaiterBills.length > 0 && (
                <div className="mb-4 space-y-2">
                  {recentWaiterBills.slice(0, 3).map((bill) => (
                    <div
                      key={bill.id}
                      className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0">
                          <Banknote className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-emerald-950 dark:text-emerald-100">
                            Table {bill.tableNumber || '—'} Bill Cleared by Waiter
                            {bill.employeeName ? ` (${bill.employeeName})` : ''}
                          </div>
                          <div className="text-xs text-emerald-800 dark:text-emerald-300 truncate">
                            {formatSalePaymentLabel(bill, activeStore.currency)} · Total{' '}
                            <strong className="font-mono">
                              {formatMoney(bill.total, activeStore.currency)}
                            </strong>
                            {bill.paymentMethod === 'cash' && (
                              <>
                                {' · '}Received{' '}
                                <span className="font-mono">
                                  {formatMoney(bill.amountTendered, activeStore.currency)}
                                </span>
                              </>
                            )}
                            {bill.changeDue > 0 && (
                              <>
                                {' · '}Return{' '}
                                <span className="font-mono">
                                  {formatMoney(bill.changeDue, activeStore.currency)}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setPrintJob({ type: 'receipt', sale: bill })}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white cursor-pointer"
                        >
                          <Printer className="w-3.5 h-3.5" />
                          <span>Print Receipt</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setRecentWaiterBills((prev) => prev.filter((b) => b.id !== bill.id))
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100/60 dark:hover:bg-emerald-950/60 cursor-pointer"
                        >
                          <span>Done</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!isRetail && pendingKotTickets.length > 0 && activeTab !== 'kot_queue' && (
                <div className="mb-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-amber-500 text-white flex items-center justify-center shrink-0">
                      <Bell className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-amber-950 dark:text-amber-100">
                        New Kitchen KOT Waiting ({pendingKotTickets.length})
                      </div>
                      <div className="text-xs text-amber-800 dark:text-amber-300 truncate">
                        {pendingKotTickets[0].tableNumber
                          ? `Table ${pendingKotTickets[0].tableNumber}`
                          : 'Counter Order'}
                        {pendingKotTickets[0].employeeName
                          ? ` · Waiter: ${pendingKotTickets[0].employeeName}`
                          : ''}
                        {` · ${pendingKotTickets[0].itemCount} item${pendingKotTickets[0].itemCount === 1 ? '' : 's'}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handlePrintKotTicket(pendingKotTickets[0], false)}
                      className="inline-flex items-center gap-1.5 rounded-lg brand-bg px-3.5 py-2 text-xs font-semibold text-white cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Print KOT Now</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('kot_queue')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/60 cursor-pointer"
                    >
                      <span>Open Queue</span>
                    </button>
                  </div>
                </div>
              )}
              {activeTab === 'billing' && (
                <BillingView
                  store={activeStore}
                  products={products}
                  sales={sales}
                  tableSessions={tableSessions}
                  kotTickets={kotTickets}
                  customers={customers}
                  employees={employees}
                  ownerId={user.uid}
                  onPrintJob={setPrintJob}
                  onUpdateKitchenStatus={(kotId, nextStatus) =>
                    handleUpdateKotKitchenStatus(activeStore.id, kotId, nextStatus, true)
                  }
                  onGoToInventory={() => setActiveTab('inventory')}
                  onGoToEmployees={() => setActiveTab('employees')}
                />
              )}
              {activeTab === 'waiter' && !isRetail && (
                <WaiterOrderView
                  store={activeStore}
                  products={products}
                  tableSessions={tableSessions}
                  kotTickets={kotTickets}
                  employees={employees}
                  onPrintJob={setPrintJob}
                  onUpdateKitchenStatus={(kotId, nextStatus) =>
                    handleUpdateKotKitchenStatus(activeStore.id, kotId, nextStatus, true)
                  }
                />
              )}
              {activeTab === 'kot_queue' && !isRetail && (
                <KitchenKotQueueView
                  store={activeStore}
                  tickets={kotTickets}
                  soundEnabled={kotSoundEnabled}
                  onToggleSound={() => setKotSoundEnabled((v) => !v)}
                  autoPrintEnabled={kotAutoPrint}
                  onToggleAutoPrint={() => setKotAutoPrint((v) => !v)}
                  onPrintTicket={handlePrintKotTicket}
                  onMarkPrinted={handleMarkKotPrinted}
                  onUpdateKitchenStatus={(kotId, nextStatus) =>
                    handleUpdateKotKitchenStatus(activeStore.id, kotId, nextStatus, true)
                  }
                  onClearPrinted={handleClearPrintedKots}
                  onTestBell={playKitchenBellChime}
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
                  employees={employees}
                  ownerId={user.uid}
                  onPrintJob={setPrintJob}
                />
              )}
              {activeTab === 'employees' && (
                <EmployeesView
                  store={activeStore}
                  employees={employees}
                  sales={sales}
                  tableSessions={tableSessions}
                  ownerId={user.uid}
                />
              )}
              {activeTab === 'analytics' && (
                <AnalyticsView
                  store={activeStore}
                  sales={sales}
                  products={products}
                  employees={employees}
                  onPrintJob={setPrintJob}
                />
              )}
              {activeTab === 'settings' && (
                <SettingsView
                  store={activeStore}
                  darkMode={darkMode}
                  onToggleDarkMode={() => setDarkMode((v) => !v)}
                  userEmail={user.email}
                  hasPassword={hasPasswordProvider}
                  onOpenPasswordSetup={() => setPasswordModalOpen(true)}
                />
              )}
            </>
          )}
          </div>
        </main>
      </div>

      {/* Onboarding Modal (auto-opens if signed-in owner has zero stores and no waiter grant) */}
      <StoreOnboardingModal
        isOpen={onboardingRequired}
        canClose={stores.length > 0}
        onClose={() => setCreateStoreOpen(false)}
        onCreate={handleCreateStore}
      />

      {/* Post-Sign-In Create / Change Password Modal */}
      <PasswordSetupModal
        user={user}
        isOpen={passwordModalOpen}
        hasPasswordProvider={hasPasswordProvider}
        onClose={handleClosePasswordModal}
        onPasswordSaved={() => setPasswordLinkedTick((t) => t + 1)}
      />

      {/* Unified Thermal Receipt, KOT, Barcode Sheet & Daily Z-Report Printer */}
      {activeStore && (
        <PrintModal
          job={printJob}
          store={activeStore}
          onClose={() => setPrintJob(null)}
          onMarkKotPrinted={(kotId) => void handleMarkKotPrinted(kotId)}
        />
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
