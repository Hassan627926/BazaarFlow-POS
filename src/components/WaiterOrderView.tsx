import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Edit3,
  KeyRound,
  LogOut,
  Minus,
  Moon,
  Plus,
  Printer,
  Search,
  ShoppingBag,
  Store,
  Sun,
  Trash2,
  UserCheck,
  UtensilsCrossed,
} from 'lucide-react';
import { doc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type CartItem,
  type Employee,
  type PrintJob,
  type Product,
  type Sale,
  type SaleItem,
  type StoreConfig,
  type TableSession,
  type WaiterAccess,
} from '../types';
import { formatMoney, generateSafeId, getTodayDateKey } from '../utils/posHelpers';
import { PWAInstallButton } from './PWAInstallButton';

interface WaiterOrderViewProps {
  store: StoreConfig;
  products: Product[];
  tableSessions: TableSession[];
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
}

function mergeSaleItems(existing: SaleItem[], additions: SaleItem[]): SaleItem[] {
  const map = new Map<string, SaleItem>();
  for (const item of existing) {
    map.set(item.productId, { ...item });
  }
  for (const add of additions) {
    const prev = map.get(add.productId);
    if (prev) {
      const nextQty = prev.quantity + add.quantity;
      map.set(add.productId, {
        ...prev,
        quantity: nextQty,
        lineTotal: Number((prev.unitPrice * nextQty).toFixed(2)),
      });
    } else {
      map.set(add.productId, { ...add });
    }
  }
  return Array.from(map.values());
}

export const WaiterOrderView: React.FC<WaiterOrderViewProps> = ({
  store,
  products,
  tableSessions,
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
}) => {
  const totalTables = Math.min(
    BLUEPRINT_LIMITS.TABLE_COUNT_MAX,
    Math.max(1, store.tableCount ?? BLUEPRINT_LIMITS.TABLE_COUNT_DEFAULT)
  );

  const canEditOrders = waiterGrant ? waiterGrant.canEditOrders !== false : true;
  const canPrintKot = waiterGrant ? waiterGrant.canPrintKot !== false : true;
  const canViewPrices = waiterGrant ? waiterGrant.canViewPrices !== false : true;

  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);
  const [ownerSelectedEmpId, setOwnerSelectedEmpId] = useState<string>('');

  const [tableFilter, setTableFilter] = useState<'all' | 'empty' | 'occupied'>('all');
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [guestName, setGuestName] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [cart, setCart] = useState<CartItem[]>([]);

  const [editingOrder, setEditingOrder] = useState<boolean>(false);
  const [editItems, setEditItems] = useState<SaleItem[]>([]);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);
  const [lastQueuedKotJob, setLastQueuedKotJob] = useState<Extract<PrintJob, { type: 'kot' }> | null>(
    null
  );

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

  const tableStats = useMemo(() => {
    const occupied = tableSessions.length;
    const empty = Math.max(0, tableNumbersList.length - occupied);
    const mine = effectiveWaiter.id
      ? tableSessions.filter((t) => t.employeeId === effectiveWaiter.id).length
      : occupied;
    return { occupied, empty, mine };
  }, [tableSessions, tableNumbersList.length, effectiveWaiter.id]);

  const filteredTables = useMemo(() => {
    return tableNumbersList.filter((num) => {
      const occ = tableSessionMap.has(num);
      if (tableFilter === 'empty') return !occ;
      if (tableFilter === 'occupied') return occ;
      return true;
    });
  }, [tableNumbersList, tableSessionMap, tableFilter]);

  const cartSaleItems = useMemo<SaleItem[]>(
    () =>
      cart.map((c) => ({
        productId: c.product.id,
        name: c.product.name,
        quantity: c.quantity,
        unitPrice: c.product.sellingPrice,
        costPrice: c.product.costPrice,
        lineTotal: Number((c.product.sellingPrice * c.quantity).toFixed(2)),
        sku: c.product.sku,
        barcode: '',
      })),
    [cart]
  );

  const cartQtyMap = useMemo(() => {
    const map = new Map<string, number>();
    if (editingOrder) {
      editItems.forEach((i) => map.set(i.productId, i.quantity));
    } else {
      cart.forEach((c) => map.set(c.product.id, c.quantity));
    }
    return map;
  }, [editingOrder, editItems, cart]);

  const editDiff = useMemo(() => {
    if (!editingOrder || !activeTableSession) return [];
    const origMap = new Map<string, SaleItem>();
    activeTableSession.items.forEach((i) => origMap.set(i.productId, i));
    const draftMap = new Map<string, SaleItem>();
    editItems.forEach((i) => draftMap.set(i.productId, i));

    const allIds = new Set<string>([...origMap.keys(), ...draftMap.keys()]);
    const diffs: Array<{
      productId: string;
      name: string;
      delta: number;
      draftQty: number;
    }> = [];
    allIds.forEach((pid) => {
      const orig = origMap.get(pid);
      const draft = draftMap.get(pid);
      const delta = (draft?.quantity ?? 0) - (orig?.quantity ?? 0);
      if (delta !== 0) {
        diffs.push({
          productId: pid,
          name: draft?.name || orig?.name || 'Item',
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
    () => cart.reduce((a, c) => a + c.product.sellingPrice * c.quantity, 0),
    [cart]
  );

  const flashNotice = (msg: string, kotJob?: Extract<PrintJob, { type: 'kot' }> | null) => {
    setNoticeMsg(msg);
    setLastQueuedKotJob(kotJob ?? null);
    window.setTimeout(() => {
      setNoticeMsg(null);
      setLastQueuedKotJob(null);
    }, 6500);
  };

  const openTable = (num: string) => {
    setSelectedTable(num);
    setCart([]);
    setEditingOrder(false);
    setEditItems([]);
    setErrorMsg(null);
    const existing = tableSessionMap.get(num);
    setGuestName(existing?.customerName || '');
  };

  const closeTable = () => {
    setSelectedTable('');
    setCart([]);
    setEditingOrder(false);
    setEditItems([]);
    setGuestName('');
    setErrorMsg(null);
  };

  const handleTapDish = (product: Product, delta: number) => {
    setErrorMsg(null);

    if (editingOrder && activeTableSession) {
      const origQty = activeTableSession.items.find((i) => i.productId === product.id)?.quantity ?? 0;
      const curQty = editItems.find((i) => i.productId === product.id)?.quantity ?? 0;
      const nextQty = curQty + delta;

      if (delta > 0) {
        const netExtra = nextQty - origQty;
        if (netExtra > product.stock) {
          setErrorMsg(`Only ${product.stock} extra ${product.unit} available for ${product.name}.`);
          return;
        }
      }

      if (nextQty <= 0) {
        setEditItems((prev) => prev.filter((i) => i.productId !== product.id));
        return;
      }

      setEditItems((prev) => {
        const exists = prev.find((i) => i.productId === product.id);
        if (exists) {
          return prev.map((i) =>
            i.productId === product.id
              ? { ...i, quantity: nextQty, lineTotal: Number((i.unitPrice * nextQty).toFixed(2)) }
              : i
          );
        }
        return [
          ...prev,
          {
            productId: product.id,
            name: product.name,
            quantity: nextQty,
            unitPrice: product.sellingPrice,
            costPrice: product.costPrice,
            lineTotal: Number((product.sellingPrice * nextQty).toFixed(2)),
            sku: product.sku,
            barcode: '',
          },
        ];
      });
      return;
    }

    // Normal order / add-on cart
    setCart((prev) => {
      const existing = prev.find((c) => c.product.id === product.id);
      if (!existing) {
        if (delta <= 0) return prev;
        if (product.stock <= 0) {
          setErrorMsg(`${product.name} is out of stock.`);
          return prev;
        }
        return [...prev, { product, quantity: 1 }];
      }
      const nextQty = existing.quantity + delta;
      if (nextQty > product.stock) {
        setErrorMsg(`Only ${product.stock} ${product.unit} available for ${product.name}.`);
        return prev;
      }
      if (nextQty <= 0) {
        return prev.filter((c) => c.product.id !== product.id);
      }
      return prev.map((c) => (c.product.id === product.id ? { ...c, quantity: nextQty } : c));
    });
  };

  const startEditingExisting = (adjustProductId?: string, delta = 0, removeAll = false) => {
    if (!activeTableSession || !canEditOrders) return;
    setErrorMsg(null);
    let draft =
      cartSaleItems.length > 0
        ? mergeSaleItems(activeTableSession.items, cartSaleItems)
        : activeTableSession.items.map((i) => ({ ...i }));

    if (adjustProductId) {
      if (delta > 0 && !removeAll) {
        const prod = products.find((p) => p.id === adjustProductId);
        const origQty =
          activeTableSession.items.find((i) => i.productId === adjustProductId)?.quantity ?? 0;
        const curQty = draft.find((i) => i.productId === adjustProductId)?.quantity ?? 0;
        if (prod && curQty + delta - origQty > prod.stock) {
          setErrorMsg(`Only ${prod.stock} extra ${prod.unit} available for ${prod.name}.`);
          return;
        }
      }
      draft = removeAll
        ? draft.filter((i) => i.productId !== adjustProductId)
        : draft
            .map((i) => {
              if (i.productId !== adjustProductId) return i;
              const nextQty = i.quantity + delta;
              return {
                ...i,
                quantity: nextQty,
                lineTotal: Number((i.unitPrice * nextQty).toFixed(2)),
              };
            })
            .filter((i) => i.quantity > 0);
    }

    setCart([]);
    setEditItems(draft);
    setEditingOrder(true);
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

      cart.forEach((c, idx) => {
        const nextStock = Math.max(0, Number((c.product.stock - c.quantity).toFixed(2)));
        batch.update(doc(db, 'stores', store.id, 'products', c.product.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });
        const logId = `${generateSafeId('log')}_${idx}`;
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId: store.ownerId,
          storeId: store.id,
          productId: c.product.id,
          productName: c.product.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -c.quantity,
          previousStock: c.product.stock,
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

    for (const d of editDiff) {
      if (d.delta > 0) {
        const prod = products.find((p) => p.id === d.productId);
        if (prod && prod.stock < d.delta) {
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

      editDiff.forEach((d, idx) => {
        const prod = products.find((p) => p.id === d.productId);
        if (!prod) return;
        const currentStock = Number.isFinite(Number(prod.stock)) ? Number(prod.stock) : 0;
        const nextStock = Math.max(0, Number((currentStock - d.delta).toFixed(2)));
        batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = `${generateSafeId('log')}_${idx}`;
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId: store.ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: String(prod.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: Number((-d.delta).toFixed(2)),
          previousStock: currentStock,
          newStock: nextStock,
          reason: d.delta > 0 ? 'sale' : 'adjustment',
          note: (isCancelling
            ? `Waiter cancelled T-${tableNum}${empName ? ` (${empName})` : ''}`
            : `Waiter edit T-${tableNum} (${d.delta > 0 ? `+${d.delta}` : d.delta})${
                empName ? ` by ${empName}` : ''
              }`
          ).slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      });

      const sanitizedItems: SaleItem[] = editItems.map((item) => {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const unitPrice = Math.max(0, Number(item.unitPrice) || 0);
        const costPrice = Math.max(0, Number(item.costPrice) || 0);
        return {
          productId: String(item.productId),
          name: String(item.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          quantity: qty,
          unitPrice,
          costPrice,
          lineTotal: Number((unitPrice * qty).toFixed(2)),
          sku: String(item.sku ?? '').slice(0, BLUEPRINT_LIMITS.SKU_MAX),
          barcode: '',
        };
      });

      if (isCancelling) {
        batch.delete(tableRef);
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
              <span>Print on Phone</span>
            </button>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs font-medium text-red-700 dark:text-red-300">
          {errorMsg}
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
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {waiterGrant ? 'My Tables' : 'Active'}
              </div>
              <div className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {tableStats.mine}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
              Tap a Table to Take Order
            </h2>
            <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'empty', label: 'Empty' },
                  { id: 'occupied', label: 'Occupied' },
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
                    isOccupied
                      ? 'border-amber-400 dark:border-amber-700 bg-amber-50/75 dark:bg-amber-950/30 hover:bg-amber-100/70 dark:hover:bg-amber-950/50'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                        Table {num}
                      </div>
                      <div
                        className={`text-[11px] font-semibold mt-0.5 ${
                          isOccupied
                            ? 'text-amber-800 dark:text-amber-300'
                            : 'text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        {isOccupied ? 'Occupied' : 'Empty'}
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

              {activeTableSession && !editingOrder && (canEditOrders || canPrintKot) && (
                <div className="flex items-center gap-1.5">
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
                  {activeTableSession.items.map((item, idx) => (
                    <div
                      key={`${item.productId}-${idx}`}
                      className="py-1.5 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-slate-900 dark:text-slate-100 truncate block">
                          {item.name}
                        </span>
                        <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {canViewPrices
                            ? `${formatMoney(item.unitPrice, store.currency)} × ${item.quantity}`
                            : `Qty: ${item.quantity}`}
                        </span>
                      </div>
                      {canEditOrders ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => startEditingExisting(item.productId, -1)}
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
                            onClick={() => startEditingExisting(item.productId, 1)}
                            className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-700 dark:text-slate-200 cursor-pointer"
                            aria-label={`Increase ${item.name}`}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditingExisting(item.productId, 0, true)}
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
                  ))}
                </div>
                <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                  {canEditOrders
                    ? 'Tap dishes below to send an Add-On order, or use - / + above to edit this order.'
                    : 'Tap dishes below to send an Add-On order for this table.'}
                </p>
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
                    {editItems.map((item) => (
                      <div
                        key={item.productId}
                        className="py-1.5 flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {item.name}
                        </span>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              const prod = products.find((p) => p.id === item.productId);
                              if (prod) handleTapDish(prod, -1);
                              else
                                setEditItems((prev) =>
                                  prev
                                    .map((i) =>
                                      i.productId === item.productId
                                        ? {
                                            ...i,
                                            quantity: i.quantity - 1,
                                            lineTotal: Number((i.unitPrice * (i.quantity - 1)).toFixed(2)),
                                          }
                                        : i
                                    )
                                    .filter((i) => i.quantity > 0)
                                );
                            }}
                            className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center cursor-pointer"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <span className="w-6 text-center font-mono font-bold">{item.quantity}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const prod = products.find((p) => p.id === item.productId);
                              if (prod) handleTapDish(prod, 1);
                            }}
                            className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-center cursor-pointer"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {editDiff.length > 0 && (
                  <div className="pt-1.5 border-t border-amber-300/60 dark:border-amber-800/60 text-[11px] font-mono space-y-0.5">
                    {editDiff.map((d) => (
                      <div
                        key={d.productId}
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
                const outOfStock = product.stock <= 0 && !editingOrder;
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
                      </div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {product.name}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        {canViewPrices && (
                          <span className="text-sm font-bold font-mono tabular-nums brand-text">
                            {formatMoney(product.sellingPrice, store.currency)}
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 font-mono">
                          {product.stock <= 0 ? 'Out of stock' : `${product.stock} left`}
                        </span>
                      </div>
                    </div>

                    {qty > 0 ? (
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
