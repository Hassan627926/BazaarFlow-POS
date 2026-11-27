import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRightLeft,
  Banknote,
  Bell,
  Check,
  CheckCheck,
  ChefHat,
  CreditCard,
  Edit3,
  KeyRound,
  Landmark,
  LogOut,
  Minus,
  Moon,
  Plus,
  Printer,
  Receipt,
  Search,
  ShoppingBag,
  StickyNote,
  Store,
  Sun,
  Trash2,
  UserCheck,
  UtensilsCrossed,
  Wallet,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type CartItem,
  type Employee,
  type KotKitchenStatus,
  type KotTicket,
  type PaymentMethod,
  type PrintJob,
  type Product,
  type ProductVariant,
  type Sale,
  type SaleItem,
  type StoreConfig,
  type TableSession,
  type WaiterAccess,
} from '../types';
import {
  computeSplitPaymentSettlement,
  formatDishNameWithVariant,
  formatMoney,
  formatSalePaymentLabel,
  generateInvoiceNumber,
  generateSafeId,
  getLineItemKey,
  getTodayDateKey,
  isProductStockTracked,
  KITCHEN_QUICK_NOTES,
} from '../utils/posHelpers';
import { PWAInstallButton } from './PWAInstallButton';

interface WaiterOrderViewProps {
  store: StoreConfig;
  products: Product[];
  tableSessions: TableSession[];
  kotTickets?: KotTicket[];
  /** Present when logged in as a Waiter via Mobile Access grant */
  waiterGrant?: WaiterAccess | null;
  /** Present when previewed/used inside Owner Console on a tablet */
  employees?: Employee[];
  /** Standalone full-screen mobile shell vs embedded inside Owner workspace */
  standalone?: boolean;
  darkMode?: boolean;
  onToggleDarkMode?: () => void;
  onSignOut?: () => void;
  onSwitchToOwner?: () => void;
  hasPassword?: boolean;
  onOpenPasswordSetup?: () => void;
  onPrintJob: (job: PrintJob) => void;
  onUpdateKitchenStatus?: (kotId: string, nextStatus: KotKitchenStatus) => Promise<void>;
}

function buildCleanSaleItem(params: {
  productId: string;
  name: string;
  variantId?: string;
  variantName?: string;
  note?: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  sku: string;
  barcode: string;
}): SaleItem {
  const item: SaleItem = {
    productId: params.productId,
    name: params.name,
    quantity: params.quantity,
    unitPrice: params.unitPrice,
    costPrice: params.costPrice,
    lineTotal: Number((params.unitPrice * params.quantity).toFixed(2)),
    sku: params.sku,
    barcode: params.barcode,
  };
  if (params.variantId) item.variantId = params.variantId;
  if (params.variantName) item.variantName = params.variantName;
  const cleanNote = (params.note || '').trim().slice(0, BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX);
  if (cleanNote) item.note = cleanNote;
  return item;
}

function mergeSaleItems(existing: SaleItem[], additions: SaleItem[]): SaleItem[] {
  const map = new Map<string, SaleItem>();
  for (const item of existing) {
    const key = getLineItemKey(item);
    const prev = map.get(key);
    if (prev) {
      const nextQty = prev.quantity + item.quantity;
      map.set(key, {
        ...prev,
        quantity: nextQty,
        lineTotal: Number((prev.unitPrice * nextQty).toFixed(2)),
      });
    } else {
      map.set(key, { ...item });
    }
  }
  for (const add of additions) {
    const key = getLineItemKey(add);
    const prev = map.get(key);
    if (prev) {
      const nextQty = prev.quantity + add.quantity;
      map.set(key, {
        ...prev,
        quantity: nextQty,
        lineTotal: Number((prev.unitPrice * nextQty).toFixed(2)),
      });
    } else {
      map.set(key, { ...add });
    }
  }
  return Array.from(map.values());
}

export const WaiterOrderView: React.FC<WaiterOrderViewProps> = ({
  store,
  products,
  tableSessions,
  kotTickets = [],
  waiterGrant,
  employees = [],
  standalone = false,
  darkMode = false,
  onToggleDarkMode,
  onSignOut,
  onSwitchToOwner,
  hasPassword = false,
  onOpenPasswordSetup,
  onPrintJob,
  onUpdateKitchenStatus,
}) => {
  const totalTables = Math.min(
    BLUEPRINT_LIMITS.TABLE_COUNT_MAX,
    Math.max(1, store.tableCount ?? BLUEPRINT_LIMITS.TABLE_COUNT_DEFAULT)
  );

  const canEditOrders = waiterGrant ? waiterGrant.canEditOrders !== false : true;
  const canPrintKot = waiterGrant ? waiterGrant.canPrintKot !== false : true;
  const canViewPrices = waiterGrant ? waiterGrant.canViewPrices !== false : true;
  const canSettleBills = waiterGrant ? waiterGrant.canSettleBills !== false : true;

  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);
  const [ownerSelectedEmpId, setOwnerSelectedEmpId] = useState<string>('');

  const [tableFilter, setTableFilter] = useState<'all' | 'empty' | 'occupied' | 'ready'>('all');
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [guestName, setGuestName] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [busyKotId, setBusyKotId] = useState<string | null>(null);

  const [editingOrder, setEditingOrder] = useState<boolean>(false);
  const [editItems, setEditItems] = useState<SaleItem[]>([]);

  // Size / Variant & Kitchen Note modals
  const [pickerProduct, setPickerProduct] = useState<Product | null>(null);
  const [pickerVariantId, setPickerVariantId] = useState<string>('');
  const [pickerNote, setPickerNote] = useState<string>('');
  const [pickerQty, setPickerQty] = useState<number>(1);
  const [noteTarget, setNoteTarget] = useState<{
    mode: 'cart' | 'edit';
    lineKey: string;
    title: string;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');

  // Table Transfer / Merge modal state
  const [transferModalOpen, setTransferModalOpen] = useState<boolean>(false);
  const [transferTargetTable, setTransferTargetTable] = useState<string>('');
  const [transferNotifyKot, setTransferNotifyKot] = useState<boolean>(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  // Waiter Cash / Table Bill Settlement Modal state
  const [billModalOpen, setBillModalOpen] = useState<boolean>(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [cashReceived, setCashReceived] = useState<string>('');
  const [splitCashInput, setSplitCashInput] = useState<string>('');
  const [splitCardInput, setSplitCardInput] = useState<string>('');
  const [splitBankQrInput, setSplitBankQrInput] = useState<string>('');
  const [settlingBill, setSettlingBill] = useState<boolean>(false);
  const [billError, setBillError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [lastQueuedKotJob, setLastQueuedKotJob] = useState<PrintJob | null>(null);

  // Resolve active waiter identity (locked to waiterGrant when signed in as waiter)
  const effectiveWaiter = useMemo(() => {
    if (waiterGrant) {
      return {
        id: waiterGrant.employeeId,
        name: waiterGrant.employeeName,
        role: waiterGrant.role,
      };
    }
    const picked = activeEmployees.find((e) => e.id === ownerSelectedEmpId);
    if (picked) {
      return { id: picked.id, name: picked.name, role: picked.role };
    }
    return { id: '', name: '', role: 'Waiter' };
  }, [waiterGrant, activeEmployees, ownerSelectedEmpId]);

  const tableSessionMap = useMemo(() => {
    const map = new Map<string, TableSession>();
    tableSessions.forEach((t) => map.set(t.tableNumber, t));
    return map;
  }, [tableSessions]);

  const tableNumbersList = useMemo(() => {
    const list: string[] = [];
    for (let i = 1; i <= totalTables; i++) list.push(String(i));
    tableSessions.forEach((t) => {
      if (!list.includes(t.tableNumber)) list.push(t.tableNumber);
    });
    return list;
  }, [totalTables, tableSessions]);

  const activeTableSession = useMemo(
    () => (selectedTable ? tableSessionMap.get(selectedTable) ?? null : null),
    [selectedTable, tableSessionMap]
  );

  const activeProducts = useMemo(() => products.filter((p) => p.active), [products]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    activeProducts.forEach((p) => set.add(p.category));
    return ['All', ...Array.from(set).sort()];
  }, [activeProducts]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeProducts.filter((p) => {
      if (selectedCategory !== 'All' && p.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
      );
    });
  }, [activeProducts, selectedCategory, searchQuery]);

  const tableKitchenStatusMap = useMemo(() => {
    const map = new Map<string, KotKitchenStatus>();
    kotTickets.forEach((t) => {
      if (!t.tableNumber || t.ticketKind === 'reprint') return;
      if (!tableSessionMap.has(t.tableNumber)) return;
      const kStatus: KotKitchenStatus =
        t.kitchenStatus === 'ready' || t.kitchenStatus === 'served' ? t.kitchenStatus : 'preparing';
      const current = map.get(t.tableNumber);
      if (kStatus === 'ready') {
        map.set(t.tableNumber, 'ready');
      } else if (kStatus === 'preparing' && current !== 'ready') {
        map.set(t.tableNumber, 'preparing');
      } else if (!current) {
        map.set(t.tableNumber, kStatus);
      }
    });
    return map;
  }, [kotTickets, tableSessionMap]);

  const readyTickets = useMemo(() => {
    const list = kotTickets.filter(
      (t) =>
        t.ticketKind !== 'reprint' &&
        t.kitchenStatus === 'ready' &&
        (!t.tableNumber || tableSessionMap.has(t.tableNumber))
    );
    return list.sort((a, b) => {
      const aMine = effectiveWaiter.id && a.employeeId === effectiveWaiter.id ? 0 : 1;
      const bMine = effectiveWaiter.id && b.employeeId === effectiveWaiter.id ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      return (a.updatedAt?.toMillis?.() ?? 0) - (b.updatedAt?.toMillis?.() ?? 0);
    });
  }, [kotTickets, tableSessionMap, effectiveWaiter.id]);

  const selectedTableActiveTickets = useMemo(() => {
    if (!selectedTable) return [];
    return kotTickets
      .filter(
        (t) =>
          t.tableNumber === selectedTable &&
          t.ticketKind !== 'reprint' &&
          t.kitchenStatus !== 'served'
      )
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
  }, [kotTickets, selectedTable]);

  const tableStats = useMemo(() => {
    const occupied = tableSessions.length;
    const empty = Math.max(0, tableNumbersList.length - occupied);
    const mine = effectiveWaiter.id
      ? tableSessions.filter((t) => t.employeeId === effectiveWaiter.id).length
      : occupied;
    const ready = Array.from(tableKitchenStatusMap.values()).filter((s) => s === 'ready').length;
    return { occupied, empty, mine, ready };
  }, [tableSessions, tableNumbersList.length, effectiveWaiter.id, tableKitchenStatusMap]);

  const filteredTables = useMemo(() => {
    return tableNumbersList.filter((num) => {
      const occ = tableSessionMap.has(num);
      if (tableFilter === 'empty') return !occ;
      if (tableFilter === 'occupied') return occ;
      if (tableFilter === 'ready') return occ && tableKitchenStatusMap.get(num) === 'ready';
      return true;
    });
  }, [tableNumbersList, tableSessionMap, tableFilter, tableKitchenStatusMap]);

  const handleMarkKotServed = async (kotId: string) => {
    if (!onUpdateKitchenStatus) return;
    setBusyKotId(kotId);
    try {
      await onUpdateKitchenStatus(kotId, 'served');
    } finally {
      setBusyKotId(null);
    }
  };

  const cartSaleItems = useMemo<SaleItem[]>(
    () =>
      cart.map((c) => {
        const unitPrice = c.variant ? c.variant.price : c.product.sellingPrice;
        const costPrice =
          c.variant?.costPrice && c.variant.costPrice > 0
            ? c.variant.costPrice
            : c.product.costPrice;
        return buildCleanSaleItem({
          productId: c.product.id,
          name: formatDishNameWithVariant(c.product.name, c.variant?.name),
          variantId: c.variant?.id,
          variantName: c.variant?.name,
          note: c.note,
          quantity: c.quantity,
          unitPrice,
          costPrice,
          sku: c.product.sku,
          barcode: '',
        });
      }),
    [cart]
  );

  const cartQtyMap = useMemo(() => {
    const map = new Map<string, number>();
    if (editingOrder) {
      editItems.forEach((i) => map.set(i.productId, (map.get(i.productId) ?? 0) + i.quantity));
    } else {
      cart.forEach((c) => map.set(c.product.id, (map.get(c.product.id) ?? 0) + c.quantity));
    }
    return map;
  }, [editingOrder, editItems, cart]);

  const editDiff = useMemo(() => {
    if (!editingOrder || !activeTableSession) return [];
    const origMap = new Map<string, SaleItem>();
    activeTableSession.items.forEach((i) => {
      const k = getLineItemKey(i);
      const prev = origMap.get(k);
      origMap.set(k, prev ? { ...prev, quantity: prev.quantity + i.quantity } : i);
    });
    const draftMap = new Map<string, SaleItem>();
    editItems.forEach((i) => {
      const k = getLineItemKey(i);
      const prev = draftMap.get(k);
      draftMap.set(k, prev ? { ...prev, quantity: prev.quantity + i.quantity } : i);
    });

    const allKeys = new Set<string>([...origMap.keys(), ...draftMap.keys()]);
    const diffs: Array<{
      lineKey: string;
      productId: string;
      name: string;
      delta: number;
      draftQty: number;
    }> = [];
    allKeys.forEach((key) => {
      const orig = origMap.get(key);
      const draft = draftMap.get(key);
      const delta = (draft?.quantity ?? 0) - (orig?.quantity ?? 0);
      if (delta !== 0) {
        const baseName = draft?.name || orig?.name || 'Item';
        const noteSuffix = draft?.note || orig?.note ? ` [${draft?.note || orig?.note}]` : '';
        diffs.push({
          lineKey: key,
          productId: draft?.productId || orig?.productId || '',
          name: `${baseName}${noteSuffix}`,
          delta,
          draftQty: draft?.quantity ?? 0,
        });
      }
    });
    return diffs;
  }, [editingOrder, activeTableSession, editItems]);

  const hasEditChanges = useMemo(() => {
    if (!editingOrder || !activeTableSession) return false;
    const cleanGuest = guestName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    return editDiff.length > 0 || cleanGuest !== (activeTableSession.customerName || '');
  }, [editingOrder, activeTableSession, editDiff, guestName]);

  const cartCount = useMemo(() => cart.reduce((a, c) => a + c.quantity, 0), [cart]);
  const cartTotal = useMemo(
    () =>
      cart.reduce(
        (a, c) => a + (c.variant ? c.variant.price : c.product.sellingPrice) * c.quantity,
        0
      ),
    [cart]
  );

  const flashNotice = (msg: string, printPreviewJob?: PrintJob | null) => {
    setNoticeMsg(msg);
    setLastQueuedKotJob(printPreviewJob ?? null);
    window.setTimeout(() => {
      setNoticeMsg(null);
      setLastQueuedKotJob(null);
    }, 6500);
  };

  const billCalculations = useMemo(() => {
    const defaultServiceRate = Number(store.serviceChargeRate ?? 0);
    if (!activeTableSession) {
      return {
        subtotal: 0,
        serviceChargeRate: defaultServiceRate,
        serviceChargeAmount: 0,
        taxRate: store.taxRate ?? 0,
        taxAmount: 0,
        total: 0,
        tendered: 0,
        changeDue: 0,
        splitMetrics: computeSplitPaymentSettlement({
          grandTotal: 0,
          cashHandedInput: '',
          cardInput: '',
          bankQrInput: '',
        }),
      };
    }
    const subtotal = Number(activeTableSession.subtotal.toFixed(2));
    const serviceChargeRate = defaultServiceRate;
    const serviceChargeAmount = Number(((subtotal * serviceChargeRate) / 100).toFixed(2));
    const taxRate = Number(store.taxRate ?? 0);
    const taxAmount = Number(((subtotal * taxRate) / 100).toFixed(2));
    const total = Number((subtotal + serviceChargeAmount + taxAmount).toFixed(2));
    const splitMetrics = computeSplitPaymentSettlement({
      grandTotal: total,
      cashHandedInput: splitCashInput,
      cardInput: splitCardInput,
      bankQrInput: splitBankQrInput,
    });
    const parsedCash = Number(cashReceived);
    const tendered =
      paymentMethod === 'split'
        ? splitMetrics.tenderedTotal
        : paymentMethod === 'cash'
        ? Number.isFinite(parsedCash) && parsedCash > 0
          ? Number(parsedCash.toFixed(2))
          : 0
        : total;
    const changeDue =
      paymentMethod === 'split'
        ? splitMetrics.changeDue
        : paymentMethod === 'cash'
        ? Math.max(0, Number((tendered - total).toFixed(2)))
        : 0;
    return {
      subtotal,
      serviceChargeRate,
      serviceChargeAmount,
      taxRate,
      taxAmount,
      total,
      tendered,
      changeDue,
      splitMetrics,
    };
  }, [
    activeTableSession,
    store.serviceChargeRate,
    store.taxRate,
    cashReceived,
    paymentMethod,
    splitCashInput,
    splitCardInput,
    splitBankQrInput,
  ]);

  const openBillModal = () => {
    if (!activeTableSession || !canSettleBills) return;
    const subtotal = Number(activeTableSession.subtotal.toFixed(2));
    const serviceChargeRate = Number(store.serviceChargeRate ?? 0);
    const serviceChargeAmount = Number(((subtotal * serviceChargeRate) / 100).toFixed(2));
    const taxRate = Number(store.taxRate ?? 0);
    const taxAmount = Number(((subtotal * taxRate) / 100).toFixed(2));
    const total = Number((subtotal + serviceChargeAmount + taxAmount).toFixed(2));
    setPaymentMethod('cash');
    setCashReceived(String(total));
    setSplitCashInput('');
    setSplitCardInput('');
    setSplitBankQrInput('');
    setBillError(null);
    setBillModalOpen(true);
  };

  const handleSettleTableBill = async () => {
    if (!activeTableSession || !selectedTable || !canSettleBills) return;
    if (paymentMethod === 'cash' && billCalculations.tendered < billCalculations.total) {
      setBillError(
        `Cash received (${formatMoney(billCalculations.tendered, store.currency)}) is less than bill total (${formatMoney(
          billCalculations.total,
          store.currency
        )}).`
      );
      return;
    }

    if (paymentMethod === 'split') {
      if (billCalculations.splitMetrics.nonCashExceedsTotal) {
        setBillError('Card + Bank/QR total cannot exceed the bill total.');
        return;
      }
      if (billCalculations.splitMetrics.remainingToPay > 0) {
        setBillError(
          `Split payments are short by ${formatMoney(
            billCalculations.splitMetrics.remainingToPay,
            store.currency
          )}.`
        );
        return;
      }
      if (billCalculations.total > 0 && billCalculations.splitMetrics.activeMethodsCount < 2) {
        setBillError(
          'Enter amounts for at least 2 payment methods (e.g. Cash + Card) for Split Payment.'
        );
        return;
      }
    }

    setSettlingBill(true);
    setBillError(null);

    const saleId = generateSafeId('sale');
    const invoiceNumber = generateInvoiceNumber(store.name);
    const dateKey = getTodayDateKey();
    const tableId = `table_${selectedTable.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
    const salePath = `stores/${store.id}/sales/${saleId}`;

    const totalCost = Number(activeTableSession.totalCost.toFixed(2));
    const profit = Number(
      (billCalculations.subtotal + billCalculations.serviceChargeAmount - totalCost).toFixed(2)
    );
    const empId = (activeTableSession.employeeId || effectiveWaiter.id || '').slice(0, 128);
    const empName = (activeTableSession.employeeName || effectiveWaiter.name || '').slice(
      0,
      BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX
    );
    const cleanGuest = (guestName.trim() || activeTableSession.customerName || '').slice(
      0,
      BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX
    );
    const settledBySource: 'waiter_mobile' | 'counter' = waiterGrant ? 'waiter_mobile' : 'counter';

    const saleRecord = {
      ownerId: store.ownerId,
      storeId: store.id,
      invoiceNumber,
      dateKey,
      items: activeTableSession.items,
      itemCount: activeTableSession.itemCount,
      subtotal: billCalculations.subtotal,
      discount: 0,
      ...(billCalculations.serviceChargeRate > 0 || billCalculations.serviceChargeAmount > 0
        ? {
            serviceChargeRate: billCalculations.serviceChargeRate,
            serviceChargeAmount: billCalculations.serviceChargeAmount,
          }
        : {}),
      taxRate: billCalculations.taxRate,
      taxAmount: billCalculations.taxAmount,
      total: billCalculations.total,
      totalCost,
      profit,
      paymentMethod,
      ...(paymentMethod === 'split' ? { paymentSplit: billCalculations.splitMetrics.paymentSplit } : {}),
      amountTendered: billCalculations.tendered,
      changeDue: billCalculations.changeDue,
      orderType: 'dine_in' as const,
      tableNumber: selectedTable,
      customerName: cleanGuest,
      employeeId: empId,
      employeeName: empName,
      settledBy: settledBySource,
      status: 'completed' as const,
    };

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'stores', store.id, 'sales', saleId), {
        ...saleRecord,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.delete(doc(db, 'stores', store.id, 'tables', tableId));
      kotTickets
        .filter(
          (t) =>
            t.tableNumber === selectedTable &&
            t.ticketKind !== 'reprint' &&
            t.kitchenStatus !== 'served'
        )
        .forEach((t) => {
          batch.update(doc(db, 'stores', store.id, 'kotQueue', t.id), {
            kitchenStatus: 'served',
            updatedAt: serverTimestamp(),
          });
        });
      await batch.commit();

      const receiptSale: Sale = {
        id: saleId,
        ...saleRecord,
        createdAt: null,
        updatedAt: null,
      };
      const clearedTableNum = selectedTable;
      setBillModalOpen(false);
      closeTable();
      flashNotice(
        `Table ${clearedTableNum} bill cleared (${formatSalePaymentLabel(
          receiptSale,
          store.currency
        )} · ${formatMoney(billCalculations.total, store.currency)})! Counter Laptop notified.`,
        { type: 'receipt', sale: receiptSale }
      );
    } catch (err) {
      setBillError(
        err instanceof Error
          ? err.message
          : 'Unable to complete table bill. Ask the Owner to check Waiter Bill Settlement access & Firestore rules.'
      );
      handleFirestoreError(err, OperationType.CREATE, salePath);
    } finally {
      setSettlingBill(false);
    }
  };

  const openTable = (num: string) => {
    setSelectedTable(num);
    setCart([]);
    setEditingOrder(false);
    setEditItems([]);
    setBillModalOpen(false);
    setBillError(null);
    setErrorMsg(null);
    const existing = tableSessionMap.get(num);
    setGuestName(existing?.customerName || '');
  };

  const closeTable = () => {
    setSelectedTable('');
    setCart([]);
    setEditingOrder(false);
    setEditItems([]);
    setBillModalOpen(false);
    setBillError(null);
    setGuestName('');
    setErrorMsg(null);
  };

  const addConfiguredDish = (
    product: Product,
    variant?: ProductVariant,
    note?: string,
    qtyDelta = 1
  ) => {
    setErrorMsg(null);
    const cleanNote = (note || '').trim().slice(0, BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX);
    const unitPrice = variant ? variant.price : product.sellingPrice;
    const costPrice =
      variant?.costPrice && variant.costPrice > 0 ? variant.costPrice : product.costPrice;
    const displayName = formatDishNameWithVariant(product.name, variant?.name);
    const lineKey = getLineItemKey({
      productId: product.id,
      variantId: variant?.id,
      variantName: variant?.name,
      note: cleanNote,
    });
    const tracked = isProductStockTracked(product);

    if (editingOrder && activeTableSession) {
      const origTotalQty = activeTableSession.items
        .filter((i) => i.productId === product.id)
        .reduce((a, i) => a + i.quantity, 0);
      const curTotalQty = editItems
        .filter((i) => i.productId === product.id)
        .reduce((a, i) => a + i.quantity, 0);
      if (qtyDelta > 0 && tracked && curTotalQty + qtyDelta - origTotalQty > product.stock) {
        setErrorMsg(`Only ${product.stock} extra ${product.unit} available for ${product.name}.`);
        return;
      }

      setEditItems((prev) => {
        const exists = prev.find((i) => getLineItemKey(i) === lineKey);
        if (exists) {
          const nextQty = exists.quantity + qtyDelta;
          return prev
            .map((i) =>
              getLineItemKey(i) === lineKey
                ? { ...i, quantity: nextQty, lineTotal: Number((i.unitPrice * nextQty).toFixed(2)) }
                : i
            )
            .filter((i) => i.quantity > 0);
        }
        if (qtyDelta <= 0) return prev;
        return [
          ...prev,
          buildCleanSaleItem({
            productId: product.id,
            name: displayName,
            variantId: variant?.id,
            variantName: variant?.name,
            note: cleanNote,
            quantity: qtyDelta,
            unitPrice,
            costPrice,
            sku: product.sku,
            barcode: '',
          }),
        ];
      });
      return;
    }

    const curCartTotal = cart
      .filter((c) => c.product.id === product.id)
      .reduce((a, c) => a + c.quantity, 0);
    if (qtyDelta > 0 && tracked && curCartTotal + qtyDelta > product.stock) {
      setErrorMsg(
        product.stock <= 0
          ? `${product.name} is out of stock.`
          : `Only ${product.stock} ${product.unit} available for ${product.name}.`
      );
      return;
    }

    setCart((prev) => {
      const existing = prev.find((c) => c.lineKey === lineKey);
      if (!existing) {
        if (qtyDelta <= 0) return prev;
        return [
          ...prev,
          {
            lineKey,
            product,
            variant,
            note: cleanNote || undefined,
            quantity: qtyDelta,
          },
        ];
      }
      const nextQty = existing.quantity + qtyDelta;
      if (nextQty <= 0) {
        return prev.filter((c) => c.lineKey !== lineKey);
      }
      return prev.map((c) => (c.lineKey === lineKey ? { ...c, quantity: nextQty } : c));
    });
  };

  const openVariantPicker = (product: Product) => {
    const firstVar = product.variants && product.variants.length > 0 ? product.variants[0] : null;
    setPickerProduct(product);
    setPickerVariantId(firstVar ? firstVar.id : '');
    setPickerNote('');
    setPickerQty(1);
    setErrorMsg(null);
  };

  const handleConfirmVariantPicker = () => {
    if (!pickerProduct) return;
    const selectedVar =
      pickerProduct.variants?.find((v) => v.id === pickerVariantId) ??
      pickerProduct.variants?.[0];
    addConfiguredDish(pickerProduct, selectedVar, pickerNote, pickerQty);
    setPickerProduct(null);
    setPickerVariantId('');
    setPickerNote('');
    setPickerQty(1);
  };

  const updateCartLineQty = (lineKey: string, delta: number) => {
    setErrorMsg(null);
    const target = cart.find((c) => c.lineKey === lineKey);
    if (!target) return;
    if (delta > 0 && isProductStockTracked(target.product)) {
      const curTotal = cart
        .filter((c) => c.product.id === target.product.id)
        .reduce((a, c) => a + c.quantity, 0);
      if (curTotal + delta > target.product.stock) {
        setErrorMsg(`Only ${target.product.stock} ${target.product.unit} available for ${target.product.name}.`);
        return;
      }
    }
    setCart((prev) =>
      prev
        .map((c) => (c.lineKey === lineKey ? { ...c, quantity: c.quantity + delta } : c))
        .filter((c) => c.quantity > 0)
    );
  };

  const updateEditLineQty = (lineKey: string, delta: number) => {
    if (!activeTableSession) return;
    setErrorMsg(null);
    const target = editItems.find((i) => getLineItemKey(i) === lineKey);
    if (!target) return;

    if (delta > 0) {
      const prod = products.find((p) => p.id === target.productId);
      const origTotalQty = activeTableSession.items
        .filter((i) => i.productId === target.productId)
        .reduce((a, i) => a + i.quantity, 0);
      const curTotalQty = editItems
        .filter((i) => i.productId === target.productId)
        .reduce((a, i) => a + i.quantity, 0);
      if (prod && isProductStockTracked(prod) && curTotalQty + delta - origTotalQty > prod.stock) {
        setErrorMsg(`Only ${prod.stock} extra ${prod.unit} available for ${prod.name}.`);
        return;
      }
    }

    setEditItems((prev) =>
      prev
        .map((i) => {
          if (getLineItemKey(i) !== lineKey) return i;
          const nextQty = i.quantity + delta;
          return {
            ...i,
            quantity: nextQty,
            lineTotal: Number((i.unitPrice * nextQty).toFixed(2)),
          };
        })
        .filter((i) => i.quantity > 0)
    );
  };

  const handleSaveKitchenNote = () => {
    if (!noteTarget) return;
    const cleanNote = noteDraft.trim().slice(0, BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX);

    if (noteTarget.mode === 'cart') {
      setCart((prev) => {
        const target = prev.find((c) => c.lineKey === noteTarget.lineKey);
        if (!target) return prev;
        const nextLineKey = getLineItemKey({
          productId: target.product.id,
          variantId: target.variant?.id,
          variantName: target.variant?.name,
          note: cleanNote,
        });
        const withoutTarget = prev.filter((c) => c.lineKey !== noteTarget.lineKey);
        const duplicate = withoutTarget.find((c) => c.lineKey === nextLineKey);
        if (duplicate) {
          return withoutTarget.map((c) =>
            c.lineKey === nextLineKey ? { ...c, quantity: c.quantity + target.quantity } : c
          );
        }
        return prev.map((c) =>
          c.lineKey === noteTarget.lineKey
            ? { ...c, lineKey: nextLineKey, note: cleanNote || undefined }
            : c
        );
      });
    } else {
      setEditItems((prev) => {
        const target = prev.find((i) => getLineItemKey(i) === noteTarget.lineKey);
        if (!target) return prev;
        const updatedItem = buildCleanSaleItem({
          productId: target.productId,
          name: target.name,
          variantId: target.variantId,
          variantName: target.variantName,
          note: cleanNote,
          quantity: target.quantity,
          unitPrice: target.unitPrice,
          costPrice: target.costPrice,
          sku: target.sku,
          barcode: '',
        });
        const nextKey = getLineItemKey(updatedItem);
        const withoutTarget = prev.filter((i) => getLineItemKey(i) !== noteTarget.lineKey);
        const duplicate = withoutTarget.find((i) => getLineItemKey(i) === nextKey);
        if (duplicate) {
          return withoutTarget.map((i) =>
            getLineItemKey(i) === nextKey
              ? {
                  ...i,
                  quantity: i.quantity + updatedItem.quantity,
                  lineTotal: Number((i.unitPrice * (i.quantity + updatedItem.quantity)).toFixed(2)),
                }
              : i
          );
        }
        return prev.map((i) => (getLineItemKey(i) === noteTarget.lineKey ? updatedItem : i));
      });
    }

    setNoteTarget(null);
    setNoteDraft('');
  };

  const handleTapDish = (product: Product, delta: number) => {
    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    if (delta > 0 && hasVariants) {
      openVariantPicker(product);
      return;
    }
    if (delta < 0) {
      if (editingOrder && activeTableSession) {
        const match = [...editItems].reverse().find((i) => i.productId === product.id);
        if (match) updateEditLineQty(getLineItemKey(match), delta);
      } else {
        const match = [...cart].reverse().find((c) => c.product.id === product.id);
        if (match) updateCartLineQty(match.lineKey, delta);
      }
      return;
    }
    addConfiguredDish(product, undefined, undefined, delta);
  };

  const startEditingExisting = (
    adjustLineKey?: string,
    delta = 0,
    removeAll = false,
    openNoteAfter = false
  ) => {
    if (!activeTableSession || !canEditOrders) return;
    setErrorMsg(null);
    let draft =
      cartSaleItems.length > 0
        ? mergeSaleItems(activeTableSession.items, cartSaleItems)
        : activeTableSession.items.map((i) => ({ ...i }));

    const targetItem = adjustLineKey
      ? draft.find((i) => getLineItemKey(i) === adjustLineKey)
      : undefined;

    if (adjustLineKey) {
      if (delta > 0 && !removeAll && targetItem) {
        const prod = products.find((p) => p.id === targetItem.productId);
        const origTotalQty = activeTableSession.items
          .filter((i) => i.productId === targetItem.productId)
          .reduce((a, i) => a + i.quantity, 0);
        const curTotalQty = draft
          .filter((i) => i.productId === targetItem.productId)
          .reduce((a, i) => a + i.quantity, 0);
        if (prod && isProductStockTracked(prod) && curTotalQty + delta - origTotalQty > prod.stock) {
          setErrorMsg(`Only ${prod.stock} extra ${prod.unit} available for ${prod.name}.`);
          return;
        }
      }
      if (removeAll) {
        draft = draft.filter((i) => getLineItemKey(i) !== adjustLineKey);
      } else if (delta !== 0) {
        draft = draft
          .map((i) => {
            if (getLineItemKey(i) !== adjustLineKey) return i;
            const nextQty = i.quantity + delta;
            return {
              ...i,
              quantity: nextQty,
              lineTotal: Number((i.unitPrice * nextQty).toFixed(2)),
            };
          })
          .filter((i) => i.quantity > 0);
      }
    }

    setCart([]);
    setEditItems(draft);
    setEditingOrder(true);

    if (openNoteAfter && targetItem && adjustLineKey) {
      setNoteTarget({
        mode: 'edit',
        lineKey: adjustLineKey,
        title: targetItem.name,
      });
      setNoteDraft(targetItem.note || '');
    }
  };

  const handlePrintProformaBill = (session: TableSession) => {
    const subtotal = Number(session.subtotal.toFixed(2));
    const serviceChargeRate = Number(store.serviceChargeRate ?? 0);
    const serviceChargeAmount = Number(((subtotal * serviceChargeRate) / 100).toFixed(2));
    const taxRate = Number(store.taxRate || 0);
    const taxAmount = Number(((subtotal * taxRate) / 100).toFixed(2));
    const total = Number((subtotal + serviceChargeAmount + taxAmount).toFixed(2));
    const billRef = `BILL-T${session.tableNumber}-${String(Date.now()).slice(-4)}`;

    const proformaSale: Sale = {
      id: generateSafeId('bill'),
      ownerId: store.ownerId,
      storeId: store.id,
      invoiceNumber: billRef,
      dateKey: getTodayDateKey(),
      items: session.items,
      itemCount: session.itemCount,
      subtotal,
      discount: 0,
      serviceChargeRate,
      serviceChargeAmount,
      taxRate,
      taxAmount,
      total,
      totalCost: Number((session.totalCost || 0).toFixed(2)),
      profit: Number((subtotal + serviceChargeAmount - (session.totalCost || 0)).toFixed(2)),
      paymentMethod: 'cash',
      amountTendered: 0,
      changeDue: 0,
      orderType: 'dine_in',
      tableNumber: session.tableNumber,
      customerName: session.customerName || '',
      employeeId: session.employeeId || effectiveWaiter.id,
      employeeName: session.employeeName || effectiveWaiter.name,
      status: 'completed',
      createdAt: session.updatedAt ?? session.createdAt ?? null,
      updatedAt: null,
    };

    onPrintJob({ type: 'receipt', sale: proformaSale, isProforma: true });
  };

  const handleReprintKot = async (session: TableSession) => {
    if (!canPrintKot) return;
    const kotId = generateSafeId('kot');
    const ticketNumber = `KOT-T${session.tableNumber}-${String(Date.now()).slice(-4)}`;
    const kotSale: Sale = {
      id: kotId,
      ownerId: store.ownerId,
      storeId: store.id,
      invoiceNumber: ticketNumber,
      dateKey: getTodayDateKey(),
      items: session.items,
      itemCount: session.itemCount,
      subtotal: session.subtotal,
      discount: 0,
      taxRate: 0,
      taxAmount: 0,
      total: session.subtotal,
      totalCost: 0,
      profit: 0,
      paymentMethod: 'cash',
      amountTendered: 0,
      changeDue: 0,
      orderType: 'dine_in',
      tableNumber: session.tableNumber,
      customerName: session.customerName || '',
      employeeId: session.employeeId || effectiveWaiter.id,
      employeeName: session.employeeName || effectiveWaiter.name,
      status: 'completed',
      createdAt: session.updatedAt ?? session.createdAt ?? null,
      updatedAt: null,
    };

    if (standalone) {
      // Push live reprint command directly to Counter/Kitchen Laptop printer
      try {
        await setDoc(doc(db, 'stores', store.id, 'kotQueue', kotId), {
          ownerId: store.ownerId,
          storeId: store.id,
          ticketNumber,
          tableNumber: session.tableNumber,
          orderType: 'dine_in',
          ticketKind: 'reprint',
          items: session.items,
          itemCount: session.itemCount,
          customerName: (session.customerName || '').slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX),
          employeeId: (session.employeeId || effectiveWaiter.id || '').slice(0, 128),
          employeeName: (session.employeeName || effectiveWaiter.name || '').slice(
            0,
            BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX
          ),
          source: 'waiter_mobile',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        flashNotice(`Reprint KOT sent to Counter & Kitchen Printer for Table ${session.tableNumber}!`, {
          type: 'kot',
          sale: kotSale,
        });
        return;
      } catch {
        // Fallback to local print preview if queue write fails
      }
    }

    onPrintJob({ type: 'kot', sale: kotSale });
  };

  /**
   * Place a new Table Order OR add Add-On items from Waiter's mobile and open KOT Print immediately
   */
  const handlePlaceOrderAndKot = async () => {
    if (!selectedTable || cart.length === 0) return;

    if (!waiterGrant && activeEmployees.length > 0 && !effectiveWaiter.id) {
      setErrorMsg('Please select your Waiter name at the top first.');
      return;
    }

    const merged = activeTableSession
      ? mergeSaleItems(activeTableSession.items, cartSaleItems)
      : cartSaleItems;

    if (merged.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setErrorMsg(`Maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct items per table.`);
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    const tableId = `table_${selectedTable.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
    const tablePath = `stores/${store.id}/tables/${tableId}`;
    const isAddOn = !!activeTableSession;

    const mergedCount = merged.reduce((acc, i) => acc + i.quantity, 0);
    const mergedSubtotal = Number(merged.reduce((acc, i) => acc + i.lineTotal, 0).toFixed(2));
    const mergedCost = Number(merged.reduce((acc, i) => acc + i.costPrice * i.quantity, 0).toFixed(2));
    const cleanGuest = guestName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    const empId = (effectiveWaiter.id || activeTableSession?.employeeId || '').slice(0, 128);
    const empName = (effectiveWaiter.name || activeTableSession?.employeeName || '').slice(
      0,
      BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX
    );

    try {
      const batch = writeBatch(db);
      const tableRef = doc(db, 'stores', store.id, 'tables', tableId);

      if (activeTableSession) {
        batch.update(tableRef, {
          items: merged,
          itemCount: mergedCount,
          subtotal: mergedSubtotal,
          totalCost: mergedCost,
          customerName: cleanGuest || activeTableSession.customerName || '',
          employeeId: activeTableSession.employeeId || empId,
          employeeName: activeTableSession.employeeName || empName,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(tableRef, {
          ownerId: store.ownerId,
          storeId: store.id,
          tableNumber: selectedTable,
          status: 'occupied',
          items: merged,
          itemCount: mergedCount,
          subtotal: mergedSubtotal,
          totalCost: mergedCost,
          customerName: cleanGuest,
          employeeId: empId,
          employeeName: empName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      const trackedByProduct = new Map<string, { product: Product; quantity: number }>();
      cart.forEach((c) => {
        if (!isProductStockTracked(c.product)) return;
        const prev = trackedByProduct.get(c.product.id);
        trackedByProduct.set(c.product.id, {
          product: c.product,
          quantity: (prev?.quantity ?? 0) + c.quantity,
        });
      });

      let logIdx = 0;
      trackedByProduct.forEach(({ product: prod, quantity }) => {
        const nextStock = Math.max(0, Number((prod.stock - quantity).toFixed(2)));
        batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });
        const logId = `${generateSafeId('log')}_${logIdx++}`;
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId: store.ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: prod.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -quantity,
          previousStock: prod.stock,
          newStock: nextStock,
          reason: 'sale',
          note: `Waiter ${isAddOn ? 'Add-on' : 'Order'} T-${selectedTable}${
            empName ? ` by ${empName}` : ''
          }`.slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      });

      const kotId = generateSafeId('kot');
      const ticketNumber = `KOT-T${selectedTable}-${String(Date.now()).slice(-4)}`;
      const kotItemCount = cartSaleItems.reduce((a, i) => a + i.quantity, 0);

      // Push live KOT to /stores/{storeId}/kotQueue so the Counter/Kitchen laptop prints immediately
      batch.set(doc(db, 'stores', store.id, 'kotQueue', kotId), {
        ownerId: store.ownerId,
        storeId: store.id,
        ticketNumber,
        tableNumber: selectedTable,
        orderType: 'dine_in',
        ticketKind: isAddOn ? 'addon' : 'new',
        items: cartSaleItems,
        itemCount: kotItemCount,
        customerName: cleanGuest,
        employeeId: empId,
        employeeName: empName,
        source: waiterGrant ? 'waiter_mobile' : 'counter',
        status: 'pending',
        kitchenStatus: 'preparing',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();

      const kotPreview: Sale = {
        id: kotId,
        ownerId: store.ownerId,
        storeId: store.id,
        invoiceNumber: ticketNumber,
        dateKey: getTodayDateKey(),
        items: cartSaleItems,
        itemCount: kotItemCount,
        subtotal: cartSaleItems.reduce((a, i) => a + i.lineTotal, 0),
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        total: cartSaleItems.reduce((a, i) => a + i.lineTotal, 0),
        totalCost: 0,
        profit: 0,
        paymentMethod: 'cash',
        amountTendered: 0,
        changeDue: 0,
        orderType: 'dine_in',
        tableNumber: selectedTable,
        customerName: cleanGuest,
        employeeId: empId,
        employeeName: empName,
        status: 'completed',
        createdAt: null,
        updatedAt: null,
      };

      const bookedTableNum = selectedTable;
      const kotJob: Extract<PrintJob, { type: 'kot' }> = {
        type: 'kot',
        sale: kotPreview,
        isAddOn,
        kotId,
      };
      closeTable();

      if (standalone) {
        // Waiter mobile: KOT is already live in Counter/Kitchen printer queue — don't block waiter's phone
        flashNotice(
          isAddOn
            ? `Add-on for Table ${bookedTableNum} sent to Counter & Kitchen Printer!`
            : `Order for Table ${bookedTableNum} sent to Counter & Kitchen Printer!`,
          canPrintKot ? kotJob : null
        );
      } else {
        flashNotice(
          isAddOn
            ? `Add-on sent for Table ${bookedTableNum}${canPrintKot ? ' — Add-On KOT ready!' : '.'}`
            : `Order placed for Table ${bookedTableNum}${canPrintKot ? ' — KOT ready!' : '.'}`
        );
        if (canPrintKot) {
          onPrintJob(kotJob);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to send table order.';
      setErrorMsg(`Order failed: ${msg}`);
      try {
        handleFirestoreError(err, isAddOn ? OperationType.UPDATE : OperationType.CREATE, tablePath);
      } catch {
        // Already surfaced to waiter UI
      }
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Save edits made by Waiter before food is served + optional Revised KOT
   */
  const handleSaveEditedOrder = async (printRevised: boolean) => {
    if (!activeTableSession || !editingOrder || !canEditOrders) return;

    const stockDeltaByProduct = new Map<string, number>();
    editDiff.forEach((d) => {
      stockDeltaByProduct.set(d.productId, (stockDeltaByProduct.get(d.productId) ?? 0) + d.delta);
    });

    for (const [pid, netDelta] of stockDeltaByProduct.entries()) {
      if (netDelta > 0) {
        const prod = products.find((p) => p.id === pid);
        if (prod && isProductStockTracked(prod) && prod.stock < netDelta) {
          setErrorMsg(`Only ${prod.stock} extra ${prod.unit} available for ${prod.name}.`);
          return;
        }
      }
    }

    setSubmitting(true);
    setErrorMsg(null);

    const tableNum = activeTableSession.tableNumber;
    const tablePath = `stores/${store.id}/tables/${activeTableSession.id}`;
    const isCancelling = editItems.length === 0;
    const cleanGuest = guestName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    const empId = (activeTableSession.employeeId || effectiveWaiter.id || '').slice(0, 128);
    const empName = (activeTableSession.employeeName || effectiveWaiter.name || '').slice(
      0,
      BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX
    );

    const changeNotes = editDiff.map((d) =>
      d.delta > 0
        ? `+${d.delta}x ${d.name}`
        : d.draftQty === 0
        ? `CANCELLED ${Math.abs(d.delta)}x ${d.name}`
        : `${d.delta}x ${d.name} (now ${d.draftQty}x)`
    );

    try {
      const batch = writeBatch(db);
      const tableRef = doc(db, 'stores', store.id, 'tables', activeTableSession.id);

      let logIdx = 0;
      stockDeltaByProduct.forEach((netDelta, pid) => {
        if (netDelta === 0) return;
        const prod = products.find((p) => p.id === pid);
        if (!prod || !isProductStockTracked(prod)) return;
        const currentStock = Number.isFinite(Number(prod.stock)) ? Number(prod.stock) : 0;
        const nextStock = Math.max(0, Number((currentStock - netDelta).toFixed(2)));
        batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = `${generateSafeId('log')}_${logIdx++}`;
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId: store.ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: String(prod.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: Number((-netDelta).toFixed(2)),
          previousStock: currentStock,
          newStock: nextStock,
          reason: netDelta > 0 ? 'sale' : 'adjustment',
          note: (isCancelling
            ? `Waiter cancelled T-${tableNum}${empName ? ` (${empName})` : ''}`
            : `Waiter edit T-${tableNum} (${netDelta > 0 ? `+${netDelta}` : netDelta})${
                empName ? ` by ${empName}` : ''
              }`
          ).slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      });

      const sanitizedItems: SaleItem[] = editItems.map((item) =>
        buildCleanSaleItem({
          productId: String(item.productId),
          name: String(item.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          variantId: item.variantId,
          variantName: item.variantName,
          note: item.note,
          quantity: Math.max(1, Number(item.quantity) || 1),
          unitPrice: Math.max(0, Number(item.unitPrice) || 0),
          costPrice: Math.max(0, Number(item.costPrice) || 0),
          sku: String(item.sku ?? '').slice(0, BLUEPRINT_LIMITS.SKU_MAX),
          barcode: '',
        })
      );

      if (isCancelling) {
        batch.delete(tableRef);
        kotTickets
          .filter(
            (t) =>
              t.tableNumber === tableNum &&
              t.ticketKind !== 'reprint' &&
              t.kitchenStatus !== 'served'
          )
          .forEach((t) => {
            batch.update(doc(db, 'stores', store.id, 'kotQueue', t.id), {
              kitchenStatus: 'served',
              updatedAt: serverTimestamp(),
            });
          });
      } else {
        batch.update(tableRef, {
          items: sanitizedItems,
          itemCount: sanitizedItems.reduce((a, i) => a + i.quantity, 0),
          subtotal: Number(sanitizedItems.reduce((a, i) => a + i.lineTotal, 0).toFixed(2)),
          totalCost: Number(
            sanitizedItems.reduce((a, i) => a + i.costPrice * i.quantity, 0).toFixed(2)
          ),
          customerName: cleanGuest,
          employeeId: empId,
          employeeName: empName,
          updatedAt: serverTimestamp(),
        });
      }

      const revKotId = !isCancelling && printRevised ? generateSafeId('kot') : '';
      const revTicketNumber = `KOT-REV-T${tableNum}-${String(Date.now()).slice(-4)}`;
      const sanitizedCount = sanitizedItems.reduce((a, i) => a + i.quantity, 0);

      if (revKotId) {
        batch.set(doc(db, 'stores', store.id, 'kotQueue', revKotId), {
          ownerId: store.ownerId,
          storeId: store.id,
          ticketNumber: revTicketNumber,
          tableNumber: tableNum,
          orderType: 'dine_in',
          ticketKind: 'revised',
          items: sanitizedItems,
          itemCount: sanitizedCount,
          changeNotes: changeNotes.slice(0, 50),
          customerName: cleanGuest,
          employeeId: empId,
          employeeName: empName,
          source: waiterGrant ? 'waiter_mobile' : 'counter',
          status: 'pending',
          kitchenStatus: 'preparing',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      const revisedKot: Sale | null =
        printRevised && !isCancelling
          ? {
              id: revKotId || `kot_rev_${Date.now()}`,
              ownerId: store.ownerId,
              storeId: store.id,
              invoiceNumber: revTicketNumber,
              dateKey: getTodayDateKey(),
              items: sanitizedItems,
              itemCount: sanitizedCount,
              subtotal: sanitizedItems.reduce((a, i) => a + i.lineTotal, 0),
              discount: 0,
              taxRate: 0,
              taxAmount: 0,
              total: sanitizedItems.reduce((a, i) => a + i.lineTotal, 0),
              totalCost: 0,
              profit: 0,
              paymentMethod: 'cash',
              amountTendered: 0,
              changeDue: 0,
              orderType: 'dine_in',
              tableNumber: tableNum,
              customerName: cleanGuest,
              employeeId: empId,
              employeeName: empName,
              status: 'completed',
              createdAt: null,
              updatedAt: null,
            }
          : null;

      const revisedJob: Extract<PrintJob, { type: 'kot' }> | null = revisedKot
        ? {
            type: 'kot',
            sale: revisedKot,
            isRevised: true,
            changeNotes,
            kotId: revKotId || undefined,
          }
        : null;

      closeTable();
      if (standalone) {
        flashNotice(
          isCancelling
            ? `Table ${tableNum} cancelled & marked Empty.`
            : `Table ${tableNum} updated${revisedKot ? ' — Revised KOT sent to Counter & Kitchen Printer!' : '.'}`,
          canPrintKot ? revisedJob : null
        );
      } else {
        flashNotice(
          isCancelling
            ? `Table ${tableNum} cancelled & marked Empty.`
            : `Table ${tableNum} updated${revisedKot ? ' — Revised KOT ready!' : '.'}`
        );
        if (revisedJob) {
          onPrintJob(revisedJob);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save order changes.';
      setErrorMsg(`Update failed: ${msg}`);
      try {
        handleFirestoreError(
          err,
          isCancelling ? OperationType.DELETE : OperationType.UPDATE,
          tablePath
        );
      } catch {
        // Already shown
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openTransferModal = () => {
    if (!activeTableSession || editingOrder || !canEditOrders) return;
    if (cart.length > 0) {
      setErrorMsg(
        'Please send your unsaved items to Kitchen (or remove them) before shifting or merging this table.'
      );
      return;
    }
    const candidates = tableNumbersList.filter((n) => n !== activeTableSession.tableNumber);
    if (candidates.length === 0) {
      setErrorMsg('No other tables configured.');
      return;
    }
    const firstEmpty = candidates.find((n) => !tableSessionMap.has(n));
    setTransferTargetTable(firstEmpty ?? candidates[0]);
    setTransferNotifyKot(false);
    setTransferError(null);
    setTransferModalOpen(true);
  };

  const handleConfirmTableTransferOrMerge = async () => {
    if (!activeTableSession || !transferTargetTable || !canEditOrders) return;
    const sourceSession = activeTableSession;
    const targetTable = transferTargetTable.trim().slice(0, BLUEPRINT_LIMITS.TABLE_MAX);
    if (!targetTable || targetTable === sourceSession.tableNumber) {
      setTransferError('Please select a different target table.');
      return;
    }

    const targetSession = tableSessionMap.get(targetTable) ?? null;
    const isMerge = !!targetSession;

    const sanitizeItem = (item: SaleItem): SaleItem =>
      buildCleanSaleItem({
        productId: String(item.productId),
        name: String(item.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
        variantId: item.variantId,
        variantName: item.variantName,
        note: item.note,
        quantity: Math.max(1, Number(item.quantity) || 1),
        unitPrice: Math.max(0, Number(item.unitPrice) || 0),
        costPrice: Math.max(0, Number(item.costPrice) || 0),
        sku: String(item.sku ?? '').slice(0, BLUEPRINT_LIMITS.SKU_MAX),
        barcode: '',
      });

    const sourceItems = sourceSession.items.map(sanitizeItem);
    const finalItems = targetSession
      ? mergeSaleItems(targetSession.items.map(sanitizeItem), sourceItems)
      : sourceItems;

    if (finalItems.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setTransferError(
        `Merged bill exceeds maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct items.`
      );
      return;
    }

    const finalCount = finalItems.reduce((acc, i) => acc + i.quantity, 0);
    const finalSubtotal = Number(finalItems.reduce((acc, i) => acc + i.lineTotal, 0).toFixed(2));
    const finalCost = Number(
      finalItems.reduce((acc, i) => acc + i.costPrice * i.quantity, 0).toFixed(2)
    );

    const guestParts = [targetSession?.customerName?.trim(), sourceSession.customerName?.trim()].filter(
      (v): v is string => !!v
    );
    const combinedCustomerName = Array.from(new Set(guestParts))
      .join(' & ')
      .slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);

    const empId = (targetSession?.employeeId || sourceSession.employeeId || effectiveWaiter.id || '').slice(
      0,
      128
    );
    const empName = (
      targetSession?.employeeName ||
      sourceSession.employeeName ||
      effectiveWaiter.name ||
      ''
    ).slice(0, BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX);

    const targetTableId = `table_${targetTable.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
    const targetPath = `stores/${store.id}/tables/${targetTableId}`;

    setSubmitting(true);
    setTransferError(null);
    setErrorMsg(null);

    try {
      const batch = writeBatch(db);
      const targetRef = doc(db, 'stores', store.id, 'tables', targetTableId);

      if (targetSession) {
        batch.update(doc(db, 'stores', store.id, 'tables', targetSession.id), {
          items: finalItems,
          itemCount: finalCount,
          subtotal: finalSubtotal,
          totalCost: finalCost,
          customerName: combinedCustomerName,
          employeeId: empId,
          employeeName: empName,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(targetRef, {
          ownerId: store.ownerId,
          storeId: store.id,
          tableNumber: targetTable,
          status: 'occupied',
          items: finalItems,
          itemCount: finalCount,
          subtotal: finalSubtotal,
          totalCost: finalCost,
          customerName: combinedCustomerName,
          employeeId: empId,
          employeeName: empName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      batch.delete(doc(db, 'stores', store.id, 'tables', sourceSession.id));

      // Keep active kitchen tickets synced with the shifted/merged table number
      kotTickets
        .filter(
          (t) =>
            t.tableNumber === sourceSession.tableNumber &&
            t.ticketKind !== 'reprint' &&
            t.kitchenStatus !== 'served'
        )
        .forEach((t) => {
          batch.update(doc(db, 'stores', store.id, 'kotQueue', t.id), {
            tableNumber: targetTable,
            updatedAt: serverTimestamp(),
          });
        });

      const changeNotes = [
        isMerge
          ? `MERGED: Table ${sourceSession.tableNumber} + Table ${targetTable} -> Table ${targetTable}`
          : `SHIFTED: Table ${sourceSession.tableNumber} -> Table ${targetTable}`,
      ];
      const kotId = transferNotifyKot ? generateSafeId('kot') : '';
      const ticketNumber = `${isMerge ? 'KOT-MRG' : 'KOT-SHF'}-T${targetTable}-${String(Date.now()).slice(-4)}`;

      if (kotId) {
        batch.set(doc(db, 'stores', store.id, 'kotQueue', kotId), {
          ownerId: store.ownerId,
          storeId: store.id,
          ticketNumber,
          tableNumber: targetTable,
          orderType: 'dine_in',
          ticketKind: 'revised',
          items: finalItems,
          itemCount: finalCount,
          changeNotes,
          customerName: combinedCustomerName,
          employeeId: empId,
          employeeName: empName,
          source: waiterGrant ? 'waiter_mobile' : 'counter',
          status: 'pending',
          kitchenStatus: 'preparing',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      setTransferModalOpen(false);
      setSelectedTable(targetTable);
      setGuestName(combinedCustomerName);

      const kotPreview: Sale | null = transferNotifyKot
        ? {
            id: kotId || `kot_shift_${Date.now()}`,
            ownerId: store.ownerId,
            storeId: store.id,
            invoiceNumber: ticketNumber,
            dateKey: getTodayDateKey(),
            items: finalItems,
            itemCount: finalCount,
            subtotal: finalSubtotal,
            discount: 0,
            taxRate: 0,
            taxAmount: 0,
            total: finalSubtotal,
            totalCost: 0,
            profit: 0,
            paymentMethod: 'cash',
            amountTendered: 0,
            changeDue: 0,
            orderType: 'dine_in',
            tableNumber: targetTable,
            customerName: combinedCustomerName,
            employeeId: empId,
            employeeName: empName,
            status: 'completed',
            createdAt: null,
            updatedAt: null,
          }
        : null;

      const kotJob: Extract<PrintJob, { type: 'kot' }> | null = kotPreview
        ? {
            type: 'kot',
            sale: kotPreview,
            isRevised: true,
            changeNotes,
            kotId: kotId || undefined,
          }
        : null;

      if (standalone) {
        flashNotice(
          isMerge
            ? `Table ${sourceSession.tableNumber} merged into Table ${targetTable}${
                kotJob ? ' — Kitchen KOT sent!' : '!'
              }`
            : `Table ${sourceSession.tableNumber} shifted to Table ${targetTable}${
                kotJob ? ' — Kitchen KOT sent!' : '!'
              }`,
          canPrintKot ? kotJob : null
        );
      } else {
        flashNotice(
          isMerge
            ? `Table ${sourceSession.tableNumber} merged into Table ${targetTable}!`
            : `Table ${sourceSession.tableNumber} shifted to Table ${targetTable}!`
        );
        if (kotJob && canPrintKot) {
          onPrintJob(kotJob);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to shift or merge table.';
      setTransferError(`Failed: ${msg}`);
      try {
        handleFirestoreError(err, isMerge ? OperationType.UPDATE : OperationType.CREATE, targetPath);
      } catch {
        // Surfaced in transferError
      }
    } finally {
      setSubmitting(false);
    }
  };

  const innerContent = (
    <div className="space-y-4 pb-28">
      {/* Waiter Identity Bar (For Owner preview/tablet mode, allow selecting which waiter is holding the tablet) */}
      {!waiterGrant && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <UserCheck className="w-4 h-4 brand-text shrink-0" />
            <span>
              <strong>Waiter Mobile Order & KOT Mode</strong> — Orders sync live to Counter POS for
              final billing.
            </span>
          </div>
          {activeEmployees.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="waiter-tablet-emp" className="text-xs text-slate-500 whitespace-nowrap">
                Waiter:
              </label>
              <select
                id="waiter-tablet-emp"
                value={ownerSelectedEmpId}
                onChange={(e) => {
                  setOwnerSelectedEmpId(e.target.value);
                  setErrorMsg(null);
                }}
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100"
              >
                <option value="">-- Select Waiter --</option>
                {activeEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.role})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {noticeMsg && (
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-4 py-2.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Check className="w-4 h-4 shrink-0" />
            <span>{noticeMsg}</span>
          </div>
          {lastQueuedKotJob && (
            <button
              type="button"
              onClick={() => onPrintJob(lastQueuedKotJob)}
              className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 shrink-0 cursor-pointer"
            >
              <Printer className="w-3 h-3" />
              <span>
                {lastQueuedKotJob.type === 'receipt' ? 'Print Receipt' : 'Print on Phone'}
              </span>
            </button>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs font-medium text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {/* LIVE KITCHEN READY ALERT BANNER */}
      {readyTickets.length > 0 && (
        <div className="space-y-2">
          {readyTickets.slice(0, 4).map((rt) => {
            const isMine = !!(effectiveWaiter.id && rt.employeeId === effectiveWaiter.id);
            return (
              <div
                key={rt.id}
                className="rounded-xl border-2 border-emerald-500 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-950/50 px-3.5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 shadow-xs"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0">
                    <Bell className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-emerald-950 dark:text-emerald-100">
                      <span>
                        {rt.tableNumber ? `Table ${rt.tableNumber}` : 'Counter Order'} Ready for Pickup!
                      </span>
                      {isMine && (
                        <span className="rounded bg-emerald-600 text-white text-[10px] font-bold px-1.5 py-0.5">
                          YOUR TABLE
                        </span>
                      )}
                      {rt.employeeName && !isMine && (
                        <span className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300">
                          · {rt.employeeName}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-emerald-800 dark:text-emerald-300 truncate mt-0.5">
                      {rt.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {rt.tableNumber && selectedTable !== rt.tableNumber && (
                    <button
                      type="button"
                      onClick={() => openTable(rt.tableNumber)}
                      className="rounded-lg border border-emerald-400 dark:border-emerald-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-emerald-900 dark:text-emerald-200 cursor-pointer"
                    >
                      Open T{rt.tableNumber}
                    </button>
                  )}
                  {onUpdateKitchenStatus && (
                    <button
                      type="button"
                      disabled={busyKotId === rt.id}
                      onClick={() => void handleMarkKotServed(rt.id)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
                    >
                      <CheckCheck className="w-3.5 h-3.5" />
                      <span>{busyKotId === rt.id ? 'Saving...' : 'Mark Served'}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* VIEW A: LIVE RESTAURANT TABLES FLOOR GRID */}
      {!selectedTable ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2.5">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Empty</div>
              <div className="text-xl font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                {tableStats.empty}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Occupied</div>
              <div className="text-xl font-bold font-mono tabular-nums text-amber-700 dark:text-amber-400">
                {tableStats.occupied}
              </div>
            </div>
            <div
              className={`rounded-xl border p-3 ${
                tableStats.ready > 0
                  ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50/70 dark:bg-emerald-950/30'
                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
              }`}
            >
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {tableStats.ready > 0 ? 'Ready to Serve' : waiterGrant ? 'My Tables' : 'Active'}
              </div>
              <div
                className={`text-xl font-bold font-mono tabular-nums ${
                  tableStats.ready > 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-900 dark:text-slate-100'
                }`}
              >
                {tableStats.ready > 0 ? tableStats.ready : tableStats.mine}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
              Tap a Table to Take Order
            </h2>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'empty', label: 'Empty' },
                  { id: 'occupied', label: 'Occupied' },
                  ...(tableStats.ready > 0
                    ? [{ id: 'ready' as const, label: `Ready (${tableStats.ready})` }]
                    : []),
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTableFilter(t.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md cursor-pointer ${
                    tableFilter === t.id
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {filteredTables.map((num) => {
              const session = tableSessionMap.get(num);
              const isOccupied = !!session;
              const kStatus = isOccupied ? tableKitchenStatusMap.get(num) : undefined;
              const isKitchenReady = kStatus === 'ready';
              return (
                <div
                  key={num}
                  onClick={() => openTable(num)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openTable(num);
                    }
                  }}
                  className={`rounded-xl border p-4 transition-all flex flex-col justify-between min-h-[116px] cursor-pointer ${
                    isKitchenReady
                      ? 'border-2 border-emerald-500 dark:border-emerald-600 bg-emerald-50/80 dark:bg-emerald-950/35 hover:bg-emerald-100/80 dark:hover:bg-emerald-950/55'
                      : isOccupied
                      ? 'border-amber-400 dark:border-amber-700 bg-amber-50/75 dark:bg-amber-950/30 hover:bg-amber-100/70 dark:hover:bg-amber-950/50'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                        Table {num}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
                        <span
                          className={`text-[11px] font-semibold ${
                            isKitchenReady
                              ? 'text-emerald-800 dark:text-emerald-300'
                              : isOccupied
                              ? 'text-amber-800 dark:text-amber-300'
                              : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {isOccupied ? 'Occupied' : 'Empty'}
                        </span>
                        {kStatus && (
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              kStatus === 'ready'
                                ? 'bg-emerald-600 text-white'
                                : kStatus === 'preparing'
                                ? 'bg-orange-100 text-orange-900 dark:bg-orange-950/70 dark:text-orange-300'
                                : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                            }`}
                          >
                            {kStatus === 'ready'
                              ? 'Ready'
                              : kStatus === 'preparing'
                              ? 'Cooking'
                              : 'Served'}
                          </span>
                        )}
                      </div>
                    </div>
                    {session && canPrintKot && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleReprintKot(session);
                        }}
                        className="rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 p-1.5 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950 cursor-pointer"
                        title="Reprint KOT"
                        aria-label={`Reprint KOT for Table ${num}`}
                      >
                        <Printer className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {session ? (
                    <div className="mt-3 pt-2 border-t border-amber-200/80 dark:border-amber-900/50 space-y-0.5">
                      <div className="flex items-center justify-between text-xs font-mono tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                        <span>{session.itemCount} items</span>
                        {canViewPrices && (
                          <span>{formatMoney(session.subtotal, store.currency)}</span>
                        )}
                      </div>
                      {session.employeeName && (
                        <div className="text-[11px] text-slate-600 dark:text-slate-400 truncate">
                          Staff: {session.employeeName}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
                      Tap to take new order
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* VIEW B: TABLE ORDER & KOT SCREEN */
        <div className="space-y-4">
          {/* Selected Table Header */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={closeTable}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Tables</span>
                </button>
                <div>
                  <h2 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                    Table {selectedTable}{' '}
                    <span
                      className={`text-xs font-medium ${
                        activeTableSession
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      · {activeTableSession ? 'Occupied' : 'New Order'}
                    </span>
                  </h2>
                  {activeTableSession?.employeeName && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      Assigned: {activeTableSession.employeeName}
                    </div>
                  )}
                </div>
              </div>

              {activeTableSession &&
                !editingOrder &&
                (canEditOrders || canPrintKot || canSettleBills || canViewPrices) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {(canViewPrices || canSettleBills) && (
                    <button
                      type="button"
                      onClick={() => handlePrintProformaBill(activeTableSession)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer"
                    >
                      <Receipt className="w-3.5 h-3.5" />
                      <span>Print Bill</span>
                    </button>
                  )}
                  {canSettleBills && (
                    <button
                      type="button"
                      onClick={openBillModal}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white cursor-pointer"
                    >
                      <Banknote className="w-3.5 h-3.5" />
                      <span>Complete Bill</span>
                    </button>
                  )}
                  {canEditOrders && (
                    <button
                      type="button"
                      onClick={openTransferModal}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                      <span>Shift / Merge</span>
                    </button>
                  )}
                  {canEditOrders && (
                    <button
                      type="button"
                      onClick={() => startEditingExisting()}
                      className="inline-flex items-center gap-1 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-300 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Edit Order</span>
                    </button>
                  )}
                  {canPrintKot && (
                    <button
                      type="button"
                      onClick={() => void handleReprintKot(activeTableSession)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>Reprint KOT</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX}
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="Guest name / special kitchen note (optional)"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            />

            {/* Live Kitchen Status Strip for Selected Table */}
            {activeTableSession && !editingOrder && selectedTableActiveTickets.length > 0 && (
              <div className="space-y-1.5">
                {selectedTableActiveTickets.map((kt) => {
                  const isReady = kt.kitchenStatus === 'ready';
                  return (
                    <div
                      key={kt.id}
                      className={`rounded-lg border px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs ${
                        isReady
                          ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-950 dark:text-emerald-100'
                          : 'border-orange-200 dark:border-orange-900/60 bg-orange-50/70 dark:bg-orange-950/25 text-orange-950 dark:text-orange-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {isReady ? (
                          <Bell className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        ) : (
                          <ChefHat className="w-3.5 h-3.5 text-orange-600 shrink-0" />
                        )}
                        <span className="font-semibold">
                          {isReady ? 'Kitchen: Ready to Serve' : 'Kitchen: Preparing'}
                        </span>
                        <span className="font-mono text-[11px] opacity-75">
                          ({kt.itemCount} items)
                        </span>
                      </div>
                      {isReady && onUpdateKitchenStatus && (
                        <button
                          type="button"
                          disabled={busyKotId === kt.id}
                          onClick={() => void handleMarkKotServed(kt.id)}
                          className="inline-flex items-center gap-1 rounded-md bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
                        >
                          <CheckCheck className="w-3 h-3" />
                          <span>{busyKotId === kt.id ? '...' : 'Mark Served'}</span>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Already Ordered Items on Occupied Table (or Live Edit Draft) */}
            {activeTableSession && !editingOrder && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-amber-900 dark:text-amber-300">
                  <span>Already Ordered ({activeTableSession.itemCount} items)</span>
                  {canViewPrices && (
                    <span className="font-mono tabular-nums">
                      {formatMoney(activeTableSession.subtotal, store.currency)}
                    </span>
                  )}
                </div>
                <div className="divide-y divide-amber-200/60 dark:divide-amber-900/40">
                  {activeTableSession.items.map((item, idx) => {
                    const lineKey = getLineItemKey(item);
                    return (
                      <div
                        key={`${lineKey}-${idx}`}
                        className="py-1.5 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-slate-900 dark:text-slate-100 truncate block">
                            {item.name}
                          </span>
                          <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 block">
                            {canViewPrices
                              ? `${formatMoney(item.unitPrice, store.currency)} × ${item.quantity}`
                              : `Qty: ${item.quantity}`}
                          </span>
                          {item.note && (
                            <span className="text-[11px] font-medium text-amber-800 dark:text-amber-300 block truncate">
                              Note: {item.note}
                            </span>
                          )}
                        </div>
                        {canEditOrders ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditingExisting(lineKey, 0, false, true)}
                              className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-600 dark:text-slate-300 cursor-pointer"
                              aria-label={`Edit note for ${item.name}`}
                              title="Kitchen Note"
                            >
                              <StickyNote className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => startEditingExisting(lineKey, -1)}
                              className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                              aria-label={`Reduce ${item.name}`}
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="w-6 text-center font-mono font-bold text-slate-900 dark:text-slate-100">
                              {item.quantity}
                            </span>
                            <button
                              type="button"
                              onClick={() => startEditingExisting(lineKey, 1)}
                              className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                              aria-label={`Increase ${item.name}`}
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => startEditingExisting(lineKey, 0, true)}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 cursor-pointer"
                              aria-label={`Remove ${item.name}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <span className="font-mono font-bold text-slate-700 dark:text-slate-300 shrink-0">
                            ×{item.quantity}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                    {canEditOrders
                      ? 'Tap dishes below to send an Add-On, edit items above, or collect cash to clear table.'
                      : 'Tap dishes below to send an Add-On, or collect cash to clear table.'}
                  </p>
                  {canSettleBills && (
                    <button
                      type="button"
                      onClick={openBillModal}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white shrink-0 cursor-pointer"
                    >
                      <Receipt className="w-3.5 h-3.5" />
                      <span>Collect Payment &amp; Clear Table</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* New Cart / Add-On Items Review (with Size & Kitchen Note controls) */}
            {!editingOrder && cart.length > 0 && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-900 dark:text-slate-100">
                  <span>
                    {activeTableSession ? `New Add-Ons (${cartCount})` : `New Order Items (${cartCount})`}
                  </span>
                  {canViewPrices && (
                    <span className="font-mono tabular-nums brand-text">
                      {formatMoney(cartTotal, store.currency)}
                    </span>
                  )}
                </div>
                <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
                  {cart.map((c) => {
                    const displayName = formatDishNameWithVariant(c.product.name, c.variant?.name);
                    const unitPrice = c.variant ? c.variant.price : c.product.sellingPrice;
                    return (
                      <div
                        key={c.lineKey}
                        className="py-1.5 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                            {displayName}
                          </div>
                          {canViewPrices && (
                            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                              {formatMoney(unitPrice, store.currency)} × {c.quantity}
                            </div>
                          )}
                          {c.note && (
                            <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300 truncate">
                              Note: {c.note}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setNoteTarget({
                                mode: 'cart',
                                lineKey: c.lineKey,
                                title: displayName,
                              });
                              setNoteDraft(c.note || '');
                            }}
                            className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium brand-text hover:underline cursor-pointer"
                          >
                            <StickyNote className="w-3 h-3" />
                            <span>{c.note ? 'Edit Note' : '+ Kitchen Note'}</span>
                          </button>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => updateCartLineQty(c.lineKey, -1)}
                            className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                            aria-label={`Decrease ${displayName}`}
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="w-6 text-center font-mono font-bold text-slate-900 dark:text-slate-100">
                            {c.quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateCartLineQty(c.lineKey, 1)}
                            className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                            aria-label={`Increase ${displayName}`}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTableSession && editingOrder && (
              <div className="rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/35 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-bold text-amber-900 dark:text-amber-200">
                    Editing Table {selectedTable} Order
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingOrder(false);
                      setEditItems([]);
                      setGuestName(activeTableSession.customerName || '');
                    }}
                    className="text-xs font-medium text-slate-600 dark:text-slate-300 underline cursor-pointer"
                  >
                    Discard
                  </button>
                </div>

                {editItems.length === 0 ? (
                  <p className="text-xs text-red-700 dark:text-red-300">
                    All items removed — tap dishes below to replace or cancel this table below.
                  </p>
                ) : (
                  <div className="divide-y divide-amber-200/60 dark:divide-amber-900/40">
                    {editItems.map((item) => {
                      const lineKey = getLineItemKey(item);
                      return (
                        <div
                          key={lineKey}
                          className="py-1.5 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-medium text-slate-900 dark:text-slate-100 truncate block">
                              {item.name}
                            </span>
                            {item.note && (
                              <span className="text-[11px] font-medium text-amber-800 dark:text-amber-300 truncate block">
                                Note: {item.note}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setNoteTarget({
                                  mode: 'edit',
                                  lineKey,
                                  title: item.name,
                                });
                                setNoteDraft(item.note || '');
                              }}
                              className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium brand-text hover:underline cursor-pointer"
                            >
                              <StickyNote className="w-3 h-3" />
                              <span>{item.note ? 'Edit Note' : '+ Kitchen Note'}</span>
                            </button>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => updateEditLineQty(lineKey, -1)}
                              className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center cursor-pointer"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="w-6 text-center font-mono font-bold">{item.quantity}</span>
                            <button
                              type="button"
                              onClick={() => updateEditLineQty(lineKey, 1)}
                              className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center cursor-pointer"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {editDiff.length > 0 && (
                  <div className="pt-1.5 border-t border-amber-300/60 dark:border-amber-800/60 text-[11px] font-mono space-y-0.5">
                    {editDiff.map((d) => (
                      <div
                        key={d.lineKey}
                        className={
                          d.delta > 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }
                      >
                        {d.delta > 0
                          ? `+${d.delta}× ${d.name}`
                          : d.draftQty === 0
                          ? `Removed ${d.name}`
                          : `${d.delta}× ${d.name} (now ${d.draftQty}×)`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Search & Categories */}
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search menu dishes..."
                className="w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3.5 py-2 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer ${
                    selectedCategory === cat
                      ? 'brand-bg text-white'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Touch-Friendly Mobile Menu Grid */}
          {filteredProducts.length === 0 ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center text-sm text-slate-500 dark:text-slate-400">
              No dishes match your search.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {filteredProducts.map((product) => {
                const qty = cartQtyMap.get(product.id) ?? 0;
                const hasVariants =
                  Array.isArray(product.variants) && product.variants.length > 0;
                const minPrice = hasVariants
                  ? Math.min(...product.variants!.map((v) => v.price))
                  : product.sellingPrice;
                const tracked = isProductStockTracked(product);
                const outOfStock = tracked && product.stock <= 0 && !editingOrder;
                return (
                  <div
                    key={product.id}
                    className={`rounded-xl border p-3.5 flex items-center justify-between gap-3 bg-white dark:bg-slate-900 transition-colors ${
                      qty > 0
                        ? 'brand-border ring-1 ring-inset ring-current/10'
                        : 'border-slate-200 dark:border-slate-800'
                    } ${outOfStock ? 'opacity-55' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                        {product.category}
                        {hasVariants ? ` · ${product.variants!.length} sizes` : ''}
                      </div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {product.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        {canViewPrices && (
                          <span className="text-sm font-bold font-mono tabular-nums brand-text">
                            {hasVariants
                              ? `From ${formatMoney(minPrice, store.currency)}`
                              : formatMoney(product.sellingPrice, store.currency)}
                          </span>
                        )}
                        <span
                          className={`text-[11px] font-mono ${
                            !tracked
                              ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                              : 'text-slate-400'
                          }`}
                        >
                          {!tracked
                            ? 'Fresh · Unlimited'
                            : product.stock <= 0
                            ? 'Out of stock'
                            : `${product.stock} left`}
                        </span>
                      </div>
                    </div>

                    {hasVariants ? (
                      <button
                        type="button"
                        disabled={outOfStock}
                        onClick={() => handleTapDish(product, 1)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:brand-bg hover:text-white px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 disabled:opacity-40 transition-colors shrink-0 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>{qty > 0 ? `Size (×${qty})` : 'Size'}</span>
                      </button>
                    ) : qty > 0 ? (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleTapDish(product, -1)}
                          className="w-9 h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-800 dark:text-slate-100 cursor-pointer"
                          aria-label={`Decrease ${product.name}`}
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <span className="w-7 text-center text-sm font-mono font-bold tabular-nums text-slate-900 dark:text-slate-100">
                          {qty}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleTapDish(product, 1)}
                          className="w-9 h-9 rounded-lg brand-bg flex items-center justify-center text-white cursor-pointer"
                          aria-label={`Increase ${product.name}`}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={outOfStock}
                        onClick={() => handleTapDish(product, 1)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:brand-bg hover:text-white px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 disabled:opacity-40 transition-colors shrink-0 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Fixed Bottom Mobile Action Bar */}
          <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs px-4 py-3 shadow-2xl no-print">
            <div className="max-w-4xl mx-auto">
              {activeTableSession && editingOrder ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {editItems.length === 0 ? (
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void handleSaveEditedOrder(false)}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>
                        {submitting
                          ? 'Cancelling...'
                          : `Cancel Table ${selectedTable} Order (Mark Empty)`}
                      </span>
                    </button>
                  ) : (
                    <>
                      {canPrintKot ? (
                        <>
                          <button
                            type="button"
                            disabled={submitting || !hasEditChanges}
                            onClick={() => void handleSaveEditedOrder(true)}
                            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl brand-bg px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer"
                          >
                            <Printer className="w-4 h-4" />
                            <span>
                              {submitting ? 'Saving...' : `Save Table ${selectedTable} & Revised KOT`}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={submitting || !hasEditChanges}
                            onClick={() => void handleSaveEditedOrder(false)}
                            className="rounded-xl border border-slate-300 dark:border-slate-700 px-3.5 py-3 text-xs font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50 cursor-pointer"
                          >
                            Save Only
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={submitting || !hasEditChanges}
                          onClick={() => void handleSaveEditedOrder(false)}
                          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl brand-bg px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer"
                        >
                          <Check className="w-4 h-4" />
                          <span>
                            {submitting ? 'Saving...' : `Save Table ${selectedTable} Changes`}
                          </span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                      <ShoppingBag className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Table {selectedTable} · {cartCount} {cartCount === 1 ? 'new item' : 'new items'}
                      </span>
                    </div>
                    {canViewPrices && (
                      <div className="text-base font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(cartTotal, store.currency)}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={submitting || cart.length === 0}
                    onClick={() => void handlePlaceOrderAndKot()}
                    className="inline-flex items-center justify-center gap-2 rounded-xl brand-bg px-5 py-3 text-sm font-semibold text-white disabled:opacity-45 transition-opacity shrink-0 cursor-pointer"
                  >
                    {canPrintKot ? (
                      <Printer className="w-4 h-4 shrink-0" />
                    ) : (
                      <Check className="w-4 h-4 shrink-0" />
                    )}
                    <span>
                      {submitting
                        ? 'Sending...'
                        : activeTableSession
                        ? standalone
                          ? 'Send Add-On to Kitchen'
                          : canPrintKot
                          ? 'Add Extras & Print KOT'
                          : 'Send Add-On Order'
                        : standalone
                        ? 'Send Order to Kitchen'
                        : canPrintKot
                        ? 'Place Order & Print KOT'
                        : 'Send Order to Kitchen'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Waiter Table Payment & Bill Completion Modal */}
      {billModalOpen && activeTableSession && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                  Complete Bill — Table {selectedTable}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Collect payment from guest. Counter Laptop will ring &amp; clear this table live.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBillModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Close payment modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Bill Breakdown */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 space-y-1.5 text-xs">
              <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                <span>Subtotal ({activeTableSession.itemCount} items)</span>
                <span className="font-mono tabular-nums">
                  {formatMoney(billCalculations.subtotal, store.currency)}
                </span>
              </div>
              {(billCalculations.serviceChargeRate > 0 || billCalculations.serviceChargeAmount > 0) && (
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Service Charge ({billCalculations.serviceChargeRate}%)</span>
                  <span className="font-mono tabular-nums">
                    {formatMoney(billCalculations.serviceChargeAmount, store.currency)}
                  </span>
                </div>
              )}
              {billCalculations.taxRate > 0 && (
                <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                  <span>Tax ({billCalculations.taxRate}%)</span>
                  <span className="font-mono tabular-nums">
                    {formatMoney(billCalculations.taxAmount, store.currency)}
                  </span>
                </div>
              )}
              <div className="pt-2 mt-1 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-base font-bold text-slate-900 dark:text-slate-100">
                <span>Total Bill</span>
                <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                  {formatMoney(billCalculations.total, store.currency)}
                </span>
              </div>
            </div>

            {/* Payment Method Selector */}
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Payment Method
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {(
                  [
                    { id: 'cash', label: 'Cash', icon: Banknote },
                    { id: 'card', label: 'Card', icon: CreditCard },
                    { id: 'bank_qr', label: 'Bank / QR', icon: Landmark },
                    { id: 'split', label: 'Split', icon: Wallet },
                  ] as const
                ).map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setPaymentMethod(id);
                      setBillError(null);
                    }}
                    className={`flex flex-col items-center justify-center gap-1 rounded-xl border py-2.5 px-2 text-xs font-semibold cursor-pointer transition-colors ${
                      paymentMethod === id
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-300'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Cash Received & Change Calculator */}
            {paymentMethod === 'cash' && (
              <div className="space-y-2.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Cash Received from Customer ({store.currency})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={cashReceived}
                    onChange={(e) => {
                      setCashReceived(e.target.value);
                      setBillError(null);
                    }}
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-base font-mono font-bold text-slate-900 dark:text-slate-100"
                  />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCashReceived(String(billCalculations.total))}
                    className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                  >
                    Exact ({billCalculations.total})
                  </button>
                  {[500, 1000, 2000, 5000]
                    .filter((amt) => amt >= billCalculations.total)
                    .map((amt) => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setCashReceived(String(amt))}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1 text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-200 cursor-pointer"
                      >
                        {amt}
                      </button>
                    ))}
                </div>

                <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 px-3.5 py-2.5 flex items-center justify-between text-xs">
                  <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                    Change / Return to Customer
                  </span>
                  <span className="text-base font-bold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    {formatMoney(billCalculations.changeDue, store.currency)}
                  </span>
                </div>
              </div>
            )}

            {/* Split Payment Breakdown Inputs */}
            {paymentMethod === 'split' && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 space-y-2.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    Split Bill ({formatMoney(billCalculations.total, store.currency)})
                  </span>
                  {(splitCashInput || splitCardInput || splitBankQrInput) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSplitCashInput('');
                        setSplitCardInput('');
                        setSplitBankQrInput('');
                        setBillError(null);
                      }}
                      className="text-[11px] font-medium text-slate-500 hover:text-red-600 cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {(
                  [
                    {
                      id: 'waiter-split-cash',
                      label: 'Cash',
                      value: splitCashInput,
                      setter: setSplitCashInput,
                      otherSum:
                        billCalculations.splitMetrics.cardAmount +
                        billCalculations.splitMetrics.bankQrAmount,
                    },
                    {
                      id: 'waiter-split-card',
                      label: 'Card',
                      value: splitCardInput,
                      setter: setSplitCardInput,
                      otherSum:
                        billCalculations.splitMetrics.cashHanded +
                        billCalculations.splitMetrics.bankQrAmount,
                    },
                    {
                      id: 'waiter-split-qr',
                      label: 'Bank / QR',
                      value: splitBankQrInput,
                      setter: setSplitBankQrInput,
                      otherSum:
                        billCalculations.splitMetrics.cashHanded +
                        billCalculations.splitMetrics.cardAmount,
                    },
                  ] as const
                ).map((row) => {
                  const restForField = Math.max(
                    0,
                    Number((billCalculations.total - row.otherSum).toFixed(2))
                  );
                  return (
                    <div key={row.id} className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={row.id}
                        className="font-semibold text-slate-700 dark:text-slate-300 whitespace-nowrap"
                      >
                        {row.label}
                      </label>
                      <div className="flex items-center gap-1.5">
                        {restForField > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              row.setter(String(restForField));
                              setBillError(null);
                            }}
                            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200 cursor-pointer whitespace-nowrap"
                          >
                            Fill Rest
                          </button>
                        )}
                        <input
                          id={row.id}
                          type="number"
                          min={0}
                          step="any"
                          inputMode="decimal"
                          value={row.value}
                          onChange={(e) => {
                            row.setter(e.target.value);
                            setBillError(null);
                          }}
                          placeholder="0.00"
                          className="w-28 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-right font-mono font-bold text-sm text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    </div>
                  );
                })}

                {billCalculations.splitMetrics.nonCashExceedsTotal ? (
                  <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 px-3 py-2 flex items-center justify-between font-semibold text-red-700 dark:text-red-300">
                    <span>Card + Bank/QR exceeds bill total</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(billCalculations.splitMetrics.nonCashTotal, store.currency)}
                    </span>
                  </div>
                ) : billCalculations.splitMetrics.remainingToPay > 0 ? (
                  <div className="rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 px-3 py-2 flex items-center justify-between font-semibold text-amber-800 dark:text-amber-300">
                    <span>Remaining to Allocate</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(billCalculations.splitMetrics.remainingToPay, store.currency)}
                    </span>
                  </div>
                ) : billCalculations.splitMetrics.changeDue > 0 ? (
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 px-3 py-2 flex items-center justify-between font-semibold text-emerald-800 dark:text-emerald-300">
                    <span>Change / Return (Cash)</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(billCalculations.splitMetrics.changeDue, store.currency)}
                    </span>
                  </div>
                ) : (
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 px-3 py-2 flex items-center justify-between font-semibold text-emerald-800 dark:text-emerald-300">
                    <span>Split Matched</span>
                    <span className="font-mono tabular-nums">
                      {formatMoney(billCalculations.total, store.currency)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {billError && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {billError}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => setBillModalOpen(false)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={settlingBill}
                onClick={() => void handleSettleTableBill()}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer"
              >
                <Check className="w-4 h-4" />
                <span>
                  {settlingBill
                    ? 'Completing Bill...'
                    : `Confirm Paid · ${formatMoney(billCalculations.total, store.currency)}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Dish Size / Variant & Kitchen Note Picker Modal */}
      {pickerProduct && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100 truncate">
                  {pickerProduct.name}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Choose size &amp; optional kitchen instructions
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickerProduct(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Close size picker"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {pickerProduct.variants && pickerProduct.variants.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Size / Portion *
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {pickerProduct.variants.map((v) => {
                    const selected = pickerVariantId === v.id;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setPickerVariantId(v.id)}
                        className={`rounded-xl border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                          selected
                            ? 'brand-border brand-soft-bg'
                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950'
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {v.name}
                        </div>
                        {canViewPrices && (
                          <div className="text-xs font-bold font-mono tabular-nums brand-text mt-0.5">
                            {formatMoney(v.price, store.currency)}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  Kitchen Note (Optional)
                </label>
                {pickerNote && (
                  <button
                    type="button"
                    onClick={() => setPickerNote('')}
                    className="text-[11px] text-slate-500 hover:text-red-600 cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {KITCHEN_QUICK_NOTES.map((chip) => {
                  const active = pickerNote.toLowerCase().includes(chip.toLowerCase());
                  return (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => {
                        if (active) return;
                        const next = pickerNote.trim() ? `${pickerNote.trim()}, ${chip}` : chip;
                        setPickerNote(next.slice(0, BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX));
                      }}
                      className={`rounded-md border px-2 py-1 text-[11px] font-medium cursor-pointer ${
                        active
                          ? 'brand-border brand-soft-bg brand-text'
                          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      + {chip}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX}
                value={pickerNote}
                onChange={(e) => setPickerNote(e.target.value)}
                placeholder="e.g. Less spicy, extra garlic sauce..."
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPickerQty((q) => Math.max(1, q - 1))}
                  className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="w-7 text-center text-sm font-mono font-bold text-slate-900 dark:text-slate-100">
                  {pickerQty}
                </span>
                <button
                  type="button"
                  onClick={() => setPickerQty((q) => q + 1)}
                  className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <button
                type="button"
                onClick={handleConfirmVariantPicker}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl brand-bg px-4 py-2.5 text-sm font-semibold text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>
                  {canViewPrices
                    ? `Add ${formatMoney(
                        (pickerProduct.variants?.find((v) => v.id === pickerVariantId)?.price ??
                          pickerProduct.sellingPrice) * pickerQty,
                        store.currency
                      )}`
                    : `Add ×${pickerQty}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kitchen Note Editor Modal */}
      {noteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100 truncate">
                  Kitchen Note — {noteTarget.title}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Sent directly to Kitchen KOT printer
                </p>
              </div>
              <button
                type="button"
                onClick={() => setNoteTarget(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Close note editor"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {KITCHEN_QUICK_NOTES.map((chip) => {
                const active = noteDraft.toLowerCase().includes(chip.toLowerCase());
                return (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => {
                      if (active) return;
                      const next = noteDraft.trim() ? `${noteDraft.trim()}, ${chip}` : chip;
                      setNoteDraft(next.slice(0, BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX));
                    }}
                    className={`rounded-md border px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                      active
                        ? 'brand-border brand-soft-bg brand-text'
                        : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    + {chip}
                  </button>
                );
              })}
            </div>

            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.KITCHEN_NOTE_MAX}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Write custom cooking instruction..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2.5 text-xs text-slate-900 dark:text-slate-100"
            />

            <div className="flex items-center justify-end gap-2">
              {noteDraft && (
                <button
                  type="button"
                  onClick={() => setNoteDraft('')}
                  className="mr-auto text-xs font-medium text-red-600 hover:underline cursor-pointer"
                >
                  Clear Note
                </button>
              )}
              <button
                type="button"
                onClick={() => setNoteTarget(null)}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveKitchenNote}
                className="rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white cursor-pointer"
              >
                Save Note
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Table Transfer (Shift) & Table Merge Modal */}
      {transferModalOpen && activeTableSession && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/65 p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                  Shift or Merge Table {activeTableSession.tableNumber}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Move to an Empty table, or pick an Occupied table to combine bills
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTransferModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Close transfer modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                From Table {activeTableSession.tableNumber} ({activeTableSession.itemCount} items)
              </span>
              {canViewPrices && (
                <span className="font-mono font-bold brand-text tabular-nums">
                  {formatMoney(activeTableSession.subtotal, store.currency)}
                </span>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Select Target Table *
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-60 overflow-y-auto pr-1">
                {tableNumbersList
                  .filter((num) => num !== activeTableSession.tableNumber)
                  .map((num) => {
                    const occ = tableSessionMap.get(num);
                    const selected = transferTargetTable === num;
                    return (
                      <button
                        key={num}
                        type="button"
                        onClick={() => {
                          setTransferTargetTable(num);
                          setTransferError(null);
                        }}
                        className={`rounded-xl border p-2.5 text-left transition-colors cursor-pointer ${
                          selected
                            ? 'brand-border brand-soft-bg ring-1 ring-inset ring-current/20'
                            : occ
                            ? 'border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 hover:border-amber-500'
                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 hover:border-slate-400'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                            Table {num}
                          </span>
                          <span
                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                              occ
                                ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300'
                                : 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300'
                            }`}
                          >
                            {occ ? 'Merge' : 'Empty'}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-1 truncate">
                          {occ
                            ? `${occ.itemCount} items${
                                canViewPrices ? ` · ${formatMoney(occ.subtotal, store.currency)}` : ''
                              }`
                            : 'Shift here'}
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>

            {transferTargetTable && (
              <div
                className={`rounded-lg border px-3 py-2 text-xs ${
                  tableSessionMap.has(transferTargetTable)
                    ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200'
                    : 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
                }`}
              >
                {tableSessionMap.has(transferTargetTable) ? (
                  <span>
                    <strong>Merge Preview:</strong> Items from Table {activeTableSession.tableNumber}{' '}
                    will combine into <strong>Table {transferTargetTable}</strong>, and Table{' '}
                    {activeTableSession.tableNumber} will become Empty.
                  </span>
                ) : (
                  <span>
                    <strong>Shift Preview:</strong> Table {activeTableSession.tableNumber} will move
                    to <strong>Table {transferTargetTable}</strong>, and Table{' '}
                    {activeTableSession.tableNumber} will become Empty.
                  </span>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={transferNotifyKot}
                onChange={(e) => setTransferNotifyKot(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700"
              />
              <span>Send Shift / Merge Notice KOT to Kitchen (optional)</span>
            </label>

            {transferError && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {transferError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setTransferModalOpen(false)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting || !transferTargetTable}
                onClick={() => void handleConfirmTableTransferOrMerge()}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl brand-bg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer"
              >
                <ArrowRightLeft className="w-4 h-4" />
                <span>
                  {submitting
                    ? 'Updating...'
                    : tableSessionMap.has(transferTargetTable)
                    ? `Merge into Table ${transferTargetTable}`
                    : `Shift to Table ${transferTargetTable}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (!standalone) {
    return innerContent;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* Standalone Mobile Waiter App Top Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs px-4 py-3 no-print">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-display font-bold text-xs overflow-hidden shrink-0"
              style={{ backgroundColor: store.primaryColor || '#0F766E' }}
            >
              {store.logoDataUrl ? (
                <img
                  src={store.logoDataUrl}
                  alt={store.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain bg-white p-0.5"
                />
              ) : (
                <UtensilsCrossed className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold font-display text-slate-900 dark:text-slate-100 truncate">
                {store.name}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {waiterGrant
                  ? `${waiterGrant.employeeName} · ${waiterGrant.role}`
                  : 'Waiter Mobile App'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {onSwitchToOwner && (
              <button
                type="button"
                onClick={onSwitchToOwner}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                title="Switch to Owner Console"
              >
                <Store className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Owner POS</span>
              </button>
            )}
            <PWAInstallButton compact />
            {onOpenPasswordSetup && (
              <button
                type="button"
                onClick={onOpenPasswordSetup}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium cursor-pointer ${
                  hasPassword
                    ? 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    : 'border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                }`}
                title={hasPassword ? 'Change login password' : 'Create password for email login'}
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">
                  {hasPassword ? 'Password' : 'Set Password'}
                </span>
              </button>
            )}
            {onToggleDarkMode && (
              <button
                type="button"
                onClick={onToggleDarkMode}
                className="rounded-lg p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                aria-label="Toggle theme"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="rounded-lg p-2 text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-4xl mx-auto p-4 no-print">{innerContent}</main>
    </div>
  );
};
