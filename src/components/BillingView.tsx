import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Banknote,
  Barcode,
  Check,
  CreditCard,
  Edit3,
  MapPin,
  Minus,
  Phone,
  Plus,
  Printer,
  QrCode,
  Search,
  ShoppingBag,
  Trash2,
  User,
  UserCheck,
  Utensils,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type CartItem,
  type Customer,
  type Employee,
  type OrderType,
  type PaymentMethod,
  type PrintJob,
  type Product,
  type Sale,
  type SaleItem,
  type StoreConfig,
  type TableSession,
} from '../types';
import {
  formatMoney,
  generateInvoiceNumber,
  generateSafeId,
  getTodayDateKey,
} from '../utils/posHelpers';

interface BillingViewProps {
  store: StoreConfig;
  products: Product[];
  tableSessions: TableSession[];
  customers: Customer[];
  employees: Employee[];
  ownerId: string;
  onPrintJob: (job: PrintJob) => void;
  onGoToInventory: () => void;
  onGoToEmployees: () => void;
}

function normalizePhoneDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 24);
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

export const BillingView: React.FC<BillingViewProps> = ({
  store,
  products,
  tableSessions,
  customers,
  employees,
  ownerId,
  onPrintJob,
  onGoToInventory,
  onGoToEmployees,
}) => {
  const isRetail = store.businessType === 'retail';
  const totalTables = Math.min(
    BLUEPRINT_LIMITS.TABLE_COUNT_MAX,
    Math.max(1, store.tableCount ?? BLUEPRINT_LIMITS.TABLE_COUNT_DEFAULT)
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [barcodeScanInput, setBarcodeScanInput] = useState('');
  const [scanMessage, setScanMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [taxRateInput, setTaxRateInput] = useState<string>(String(store.taxRate ?? 0));
  const [discountInput, setDiscountInput] = useState<string>('0');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [amountTenderedInput, setAmountTenderedInput] = useState<string>('');
  const [orderType, setOrderType] = useState<OrderType>(isRetail ? 'retail' : 'dine_in');
  const [tableNumber, setTableNumber] = useState<string>('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [customerName, setCustomerName] = useState<string>('');
  const [customerPhone, setCustomerPhone] = useState<string>('');
  const [customerAddress, setCustomerAddress] = useState<string>('');
  const [matchedCustomer, setMatchedCustomer] = useState<Customer | null>(null);
  const [editingAddress, setEditingAddress] = useState<boolean>(false);
  const [updatingAddress, setUpdatingAddress] = useState<boolean>(false);
  const [addressSavedNotice, setAddressSavedNotice] = useState<boolean>(false);

  const [editingTableOrder, setEditingTableOrder] = useState<boolean>(false);
  const [editTableItems, setEditTableItems] = useState<SaleItem[]>([]);

  const [processing, setProcessing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [lastCompletedSale, setLastCompletedSale] = useState<Sale | null>(null);

  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const addressInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync manual/default bill tax input whenever active store or its default tax rate changes
  useEffect(() => {
    setTaxRateInput(String(store.taxRate ?? 0));
  }, [store.id, store.taxRate]);

  const tableSessionMap = useMemo(() => {
    const map = new Map<string, TableSession>();
    tableSessions.forEach((t) => map.set(t.tableNumber, t));
    return map;
  }, [tableSessions]);

  const activeTableSession = useMemo(() => {
    if (isRetail || orderType !== 'dine_in' || !tableNumber) return null;
    return tableSessionMap.get(tableNumber) ?? null;
  }, [isRetail, orderType, tableNumber, tableSessionMap]);

  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);

  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === selectedEmployeeId) ?? null,
    [employees, selectedEmployeeId]
  );

  const resolvedEmployeeId = selectedEmployee
    ? selectedEmployee.id
    : activeTableSession?.employeeId && selectedEmployeeId === activeTableSession.employeeId
    ? activeTableSession.employeeId
    : '';

  const resolvedEmployeeName = selectedEmployee
    ? selectedEmployee.name
    : activeTableSession?.employeeId && selectedEmployeeId === activeTableSession.employeeId
    ? activeTableSession.employeeName || ''
    : '';

  const tableNumbersList = useMemo(() => {
    const list: string[] = [];
    for (let i = 1; i <= totalTables; i++) {
      list.push(String(i));
    }
    // Include any occupied table numbers above configured count so nothing is hidden
    tableSessions.forEach((t) => {
      if (!list.includes(t.tableNumber)) list.push(t.tableNumber);
    });
    return list;
  }, [totalTables, tableSessions]);

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
        p.sku.toLowerCase().includes(q) ||
        (isRetail && p.barcode.toLowerCase().includes(q)) ||
        p.category.toLowerCase().includes(q)
      );
    });
  }, [activeProducts, selectedCategory, searchQuery, isRetail]);

  const showTempNotice = (msg: string) => {
    setStatusNotice(msg);
    window.setTimeout(() => setStatusNotice(null), 3200);
  };

  const handleOrderTypeSwitch = (nextType: OrderType) => {
    setOrderType(nextType);
    setCheckoutError(null);
    setEditingTableOrder(false);
    setEditTableItems([]);
    if (nextType !== 'dine_in') {
      setTableNumber('');
    }
    if (nextType !== 'delivery') {
      setEditingAddress(false);
    }
  };

  const handleTableSelect = (nextTable: string) => {
    setTableNumber(nextTable);
    setCheckoutError(null);
    setEditingTableOrder(false);
    setEditTableItems([]);
    const existing = tableSessionMap.get(nextTable);
    if (existing) {
      setCustomerName(existing.customerName || '');
      setSelectedEmployeeId(existing.employeeId || '');
    } else {
      setCustomerName('');
      setSelectedEmployeeId('');
    }
  };

  const startEditingTableOrder = () => {
    if (!activeTableSession) return;
    setCheckoutError(null);
    const mergedDraft =
      cartSaleItems.length > 0
        ? mergeSaleItems(activeTableSession.items, cartSaleItems)
        : activeTableSession.items.map((item) => ({ ...item }));
    setEditTableItems(mergedDraft);
    setCart([]);
    setEditingTableOrder(true);
  };

  const cancelEditingTableOrder = () => {
    setEditingTableOrder(false);
    setEditTableItems([]);
    setCheckoutError(null);
    if (activeTableSession) {
      setCustomerName(activeTableSession.customerName || '');
      setSelectedEmployeeId(activeTableSession.employeeId || '');
    }
  };

  const updateEditTableItemQty = (productId: string, delta: number) => {
    if (!activeTableSession) return;
    setCheckoutError(null);

    if (delta > 0) {
      const product = products.find((p) => p.id === productId);
      const originalQty =
        activeTableSession.items.find((i) => i.productId === productId)?.quantity ?? 0;
      const currentDraftQty = editTableItems.find((i) => i.productId === productId)?.quantity ?? 0;
      const netExtraNeeded = currentDraftQty + delta - originalQty;
      if (product && netExtraNeeded > product.stock) {
        setCheckoutError(
          `Only ${product.stock} extra ${product.unit} available in stock for ${product.name}.`
        );
        return;
      }
    }

    setEditTableItems((prev) =>
      prev
        .map((item) => {
          if (item.productId !== productId) return item;
          const nextQty = item.quantity + delta;
          return {
            ...item,
            quantity: nextQty,
            lineTotal: Number((item.unitPrice * nextQty).toFixed(2)),
          };
        })
        .filter((item) => item.quantity > 0)
    );
  };

  const removeEditTableItem = (productId: string) => {
    setCheckoutError(null);
    setEditTableItems((prev) => prev.filter((item) => item.productId !== productId));
  };

  const startEditingAndAdjustItem = (productId: string, delta: number, removeAll = false) => {
    if (!activeTableSession) return;
    setCheckoutError(null);

    const baseDraft =
      cartSaleItems.length > 0
        ? mergeSaleItems(activeTableSession.items, cartSaleItems)
        : activeTableSession.items.map((item) => ({ ...item }));

    if (delta > 0 && !removeAll) {
      const product = products.find((p) => p.id === productId);
      const originalQty =
        activeTableSession.items.find((i) => i.productId === productId)?.quantity ?? 0;
      const currentDraftQty = baseDraft.find((i) => i.productId === productId)?.quantity ?? 0;
      const netExtraNeeded = currentDraftQty + delta - originalQty;
      if (product && netExtraNeeded > product.stock) {
        setCheckoutError(
          `Only ${product.stock} extra ${product.unit} available in stock for ${product.name}.`
        );
        return;
      }
    }

    const nextDraft = removeAll
      ? baseDraft.filter((item) => item.productId !== productId)
      : baseDraft
          .map((item) => {
            if (item.productId !== productId) return item;
            const nextQty = item.quantity + delta;
            return {
              ...item,
              quantity: nextQty,
              lineTotal: Number((item.unitPrice * nextQty).toFixed(2)),
            };
          })
          .filter((item) => item.quantity > 0);

    setCart([]);
    setEditTableItems(nextDraft);
    setEditingTableOrder(true);
  };

  const handlePhoneChange = (rawValue: string) => {
    setCustomerPhone(rawValue);
    setAddressSavedNotice(false);
    const digits = normalizePhoneDigits(rawValue);
    if (digits.length >= 4) {
      const found = customers.find((c) => c.phoneDigits === digits);
      if (found) {
        setMatchedCustomer(found);
        setCustomerName(found.name);
        if (found.address) {
          setCustomerAddress(found.address);
        }
        setEditingAddress(false);
        return;
      }
    }
    setMatchedCustomer(null);
  };

  const handleSaveUpdatedCustomerAddress = async () => {
    if (!matchedCustomer) return;
    const cleanAddr = customerAddress.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_ADDRESS_MAX);
    const cleanName = customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX) || matchedCustomer.name;
    if (!cleanAddr) {
      setCheckoutError('Delivery address cannot be empty.');
      return;
    }

    setUpdatingAddress(true);
    setCheckoutError(null);
    const path = `stores/${store.id}/customers/${matchedCustomer.id}`;
    try {
      await updateDoc(doc(db, 'stores', store.id, 'customers', matchedCustomer.id), {
        name: cleanName,
        phone: customerPhone.trim().slice(0, BLUEPRINT_LIMITS.PHONE_MAX) || matchedCustomer.phone,
        address: cleanAddr,
        updatedAt: serverTimestamp(),
      });
      setMatchedCustomer({ ...matchedCustomer, name: cleanName, address: cleanAddr });
      setEditingAddress(false);
      setAddressSavedNotice(true);
      window.setTimeout(() => setAddressSavedNotice(false), 2600);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setUpdatingAddress(false);
    }
  };

  const addToCart = (product: Product) => {
    // When editing an occupied table's order, tapping a menu item adds/swaps it directly into the edit draft
    if (editingTableOrder && activeTableSession) {
      setCheckoutError(null);
      const originalQty =
        activeTableSession.items.find((i) => i.productId === product.id)?.quantity ?? 0;
      const currentDraftQty = editTableItems.find((i) => i.productId === product.id)?.quantity ?? 0;
      const netExtraNeeded = currentDraftQty + 1 - originalQty;
      if (netExtraNeeded > product.stock) {
        setCheckoutError(
          product.stock <= 0
            ? `${product.name} is out of stock.`
            : `Only ${product.stock} extra ${product.unit} available for ${product.name}.`
        );
        return;
      }
      setEditTableItems((prev) => {
        const existing = prev.find((i) => i.productId === product.id);
        if (existing) {
          const nextQty = existing.quantity + 1;
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
            quantity: 1,
            unitPrice: product.sellingPrice,
            costPrice: product.costPrice,
            lineTotal: Number(product.sellingPrice.toFixed(2)),
            sku: product.sku,
            barcode: isRetail ? product.barcode : '',
          },
        ];
      });
      return;
    }

    if (product.stock <= 0) {
      setCheckoutError(`${product.name} is out of stock.`);
      return;
    }
    setCheckoutError(null);
    setCart((prev) => {
      const existing = prev.find((c) => c.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stock) {
          setCheckoutError(`Only ${product.stock} ${product.unit} available for ${product.name}.`);
          return prev;
        }
        return prev.map((c) =>
          c.product.id === product.id ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
  };

  const updateCartQty = (productId: string, delta: number) => {
    setCheckoutError(null);
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.product.id !== productId) return item;
          const nextQty = item.quantity + delta;
          if (nextQty > item.product.stock) {
            setCheckoutError(
              `Stock limit reached (${item.product.stock} ${item.product.unit}) for ${item.product.name}.`
            );
            return item;
          }
          return { ...item, quantity: nextQty };
        })
        .filter((item) => item.quantity > 0)
    );
  };

  const removeFromCart = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
  };

  const clearCart = (keepTable = false) => {
    setCart([]);
    setTaxRateInput(String(store.taxRate ?? 0));
    setDiscountInput('0');
    setAmountTenderedInput('');
    setEditingTableOrder(false);
    setEditTableItems([]);
    if (!keepTable) {
      setTableNumber('');
      setSelectedEmployeeId('');
      setCustomerName('');
      setCustomerPhone('');
      setCustomerAddress('');
      setMatchedCustomer(null);
      setEditingAddress(false);
    }
    setCheckoutError(null);
  };

  const handleBarcodeScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isRetail) return;
    const code = barcodeScanInput.trim();
    if (!code) return;

    const match = activeProducts.find(
      (p) =>
        p.barcode.toLowerCase() === code.toLowerCase() ||
        p.sku.toLowerCase() === code.toLowerCase()
    );

    if (match) {
      addToCart(match);
      setScanMessage({ type: 'ok', text: `Added ${match.name}` });
    } else {
      setScanMessage({ type: 'err', text: `No product matches barcode "${code}"` });
    }
    setBarcodeScanInput('');
    scanInputRef.current?.focus();
    window.setTimeout(() => setScanMessage(null), 2600);
  };

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
        barcode: isRetail ? c.product.barcode : '',
      })),
    [cart, isRetail]
  );

  // Compute live diff when editing an occupied table order
  const tableOrderDiff = useMemo(() => {
    if (!editingTableOrder || !activeTableSession) return [];
    const origMap = new Map<string, SaleItem>();
    activeTableSession.items.forEach((i) => origMap.set(i.productId, i));
    const draftMap = new Map<string, SaleItem>();
    editTableItems.forEach((i) => draftMap.set(i.productId, i));

    const allIds = new Set<string>([...origMap.keys(), ...draftMap.keys()]);
    const diffs: Array<{
      productId: string;
      name: string;
      delta: number;
      origQty: number;
      draftQty: number;
    }> = [];

    allIds.forEach((pid) => {
      const orig = origMap.get(pid);
      const draft = draftMap.get(pid);
      const origQty = orig?.quantity ?? 0;
      const draftQty = draft?.quantity ?? 0;
      const delta = draftQty - origQty;
      if (delta !== 0) {
        diffs.push({
          productId: pid,
          name: draft?.name || orig?.name || 'Item',
          delta,
          origQty,
          draftQty,
        });
      }
    });
    return diffs;
  }, [editingTableOrder, activeTableSession, editTableItems]);

  const hasTableEditChanges = useMemo(() => {
    if (!editingTableOrder || !activeTableSession) return false;
    const cleanGuest = customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    return (
      tableOrderDiff.length > 0 ||
      cleanGuest !== (activeTableSession.customerName || '') ||
      resolvedEmployeeId !== (activeTableSession.employeeId || '')
    );
  }, [editingTableOrder, activeTableSession, tableOrderDiff, customerName, resolvedEmployeeId]);

  // Combined items if settling an occupied dine-in table + new cart add-ons (or live edit draft)
  const combinedItems = useMemo<SaleItem[]>(() => {
    if (activeTableSession && editingTableOrder) {
      return editTableItems;
    }
    if (activeTableSession) {
      return mergeSaleItems(activeTableSession.items, cartSaleItems);
    }
    return cartSaleItems;
  }, [activeTableSession, editingTableOrder, editTableItems, cartSaleItems]);

  const subtotal = useMemo(
    () => combinedItems.reduce((acc, i) => acc + i.lineTotal, 0),
    [combinedItems]
  );

  const totalCost = useMemo(
    () => combinedItems.reduce((acc, i) => acc + i.costPrice * i.quantity, 0),
    [combinedItems]
  );

  const discount = useMemo(() => {
    const val = Number(discountInput);
    if (!Number.isFinite(val) || val < 0) return 0;
    return Math.min(val, subtotal);
  }, [discountInput, subtotal]);

  const effectiveTaxRate = useMemo(() => {
    if (!taxRateInput.trim()) return 0;
    const val = Number(taxRateInput);
    if (!Number.isFinite(val) || val < 0) return 0;
    return Math.min(50, Number(val.toFixed(2)));
  }, [taxRateInput]);

  const taxableBase = Math.max(0, subtotal - discount);
  const taxAmount = useMemo(
    () => Number(((taxableBase * effectiveTaxRate) / 100).toFixed(2)),
    [taxableBase, effectiveTaxRate]
  );
  const grandTotal = useMemo(() => Number((taxableBase + taxAmount).toFixed(2)), [taxableBase, taxAmount]);
  const totalItemsCount = useMemo(
    () => combinedItems.reduce((acc, i) => acc + i.quantity, 0),
    [combinedItems]
  );

  const parsedTendered = useMemo(() => {
    if (paymentMethod !== 'cash') return grandTotal;
    const val = Number(amountTenderedInput);
    if (!amountTenderedInput.trim() || !Number.isFinite(val)) return grandTotal;
    return val;
  }, [amountTenderedInput, grandTotal, paymentMethod]);

  const changeDue = Math.max(0, Number((parsedTendered - grandTotal).toFixed(2)));

  const cashShortfall = useMemo(() => {
    if (paymentMethod !== 'cash' || !amountTenderedInput.trim() || grandTotal <= 0) return 0;
    const val = Number(amountTenderedInput);
    if (!Number.isFinite(val) || val >= grandTotal) return 0;
    return Number((grandTotal - val).toFixed(2));
  }, [paymentMethod, amountTenderedInput, grandTotal]);

  const quickCashSuggestions = useMemo(() => {
    if (grandTotal <= 0) return [];
    const exact = Number(grandTotal.toFixed(2));
    const candidates = [
      exact,
      Math.ceil(exact / 100) * 100,
      Math.ceil(exact / 500) * 500,
      Math.ceil(exact / 1000) * 1000,
      Math.ceil(exact / 5000) * 5000,
    ];
    return Array.from(new Set(candidates)).slice(0, 4);
  }, [grandTotal]);

  /**
   * Book an Empty Dine-In Table OR Add Add-On Items to an Already Occupied Table (with KOT print)
   */
  const handleBookOrAddOnTable = async () => {
    if (isRetail || orderType !== 'dine_in') return;
    if (!tableNumber) {
      setCheckoutError('Please select a Table from the dropdown first.');
      return;
    }
    if (activeEmployees.length > 0 && !resolvedEmployeeId) {
      setCheckoutError('Please select the Employee handling this table.');
      return;
    }
    if (cart.length === 0) {
      setCheckoutError(
        activeTableSession
          ? 'Tap add-on items on the left before adding to this occupied table.'
          : 'Add at least one dish to book this table.'
      );
      return;
    }

    const merged = activeTableSession
      ? mergeSaleItems(activeTableSession.items, cartSaleItems)
      : cartSaleItems;

    if (merged.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setCheckoutError(`Maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct items per table.`);
      return;
    }

    setProcessing(true);
    setCheckoutError(null);

    const tableId = `table_${tableNumber.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
    const tablePath = `stores/${store.id}/tables/${tableId}`;
    const isAddOn = !!activeTableSession;

    const mergedCount = merged.reduce((acc, i) => acc + i.quantity, 0);
    const mergedSubtotal = Number(merged.reduce((acc, i) => acc + i.lineTotal, 0).toFixed(2));
    const mergedCost = Number(merged.reduce((acc, i) => acc + i.costPrice * i.quantity, 0).toFixed(2));
    const cleanGuest = customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    const finalEmpId = (resolvedEmployeeId || activeTableSession?.employeeId || '').slice(0, 128);
    const finalEmpName = (resolvedEmployeeName || activeTableSession?.employeeName || '').slice(
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
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(tableRef, {
          ownerId,
          storeId: store.id,
          tableNumber,
          status: 'occupied',
          items: merged,
          itemCount: mergedCount,
          subtotal: mergedSubtotal,
          totalCost: mergedCost,
          customerName: cleanGuest,
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      // Deduct stock ONLY for newly added cart items
      for (const c of cart) {
        const nextStock = Math.max(0, Number((c.product.stock - c.quantity).toFixed(2)));
        batch.update(doc(db, 'stores', store.id, 'products', c.product.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });
        const logId = generateSafeId('log');
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId,
          storeId: store.id,
          productId: c.product.id,
          productName: c.product.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -c.quantity,
          previousStock: c.product.stock,
          newStock: nextStock,
          reason: 'sale',
          note: `${isAddOn ? 'Add-on' : 'Booked'} Table ${tableNumber}${
            finalEmpName ? ` by ${finalEmpName}` : ''
          }`.slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      }

      await batch.commit();

      const kotSalePreview: Sale = {
        id: `kot_${Date.now()}`,
        ownerId,
        storeId: store.id,
        invoiceNumber: `KOT-T${tableNumber}`,
        dateKey: getTodayDateKey(),
        items: cartSaleItems,
        itemCount: cartSaleItems.reduce((a, i) => a + i.quantity, 0),
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
        tableNumber,
        customerName: cleanGuest,
        employeeId: finalEmpId,
        employeeName: finalEmpName,
        status: 'completed',
        createdAt: null,
        updatedAt: null,
      };

      clearCart(false);
      setMobileCartOpen(false);
      showTempNotice(
        isAddOn
          ? `Add-on added to Table ${tableNumber} — ready to print Add-On KOT.`
          : `Table ${tableNumber} is now Occupied — KOT generated.`
      );
      onPrintJob({ type: 'kot', sale: kotSalePreview, isAddOn });
    } catch (err) {
      handleFirestoreError(err, isAddOn ? OperationType.UPDATE : OperationType.CREATE, tablePath);
    } finally {
      setProcessing(false);
    }
  };

  /**
   * Save edits made to an already Occupied Dine-In Table before food is served
   * (reduce/increase qty, remove/swap items, or cancel table if all items removed)
   */
  const handleSaveTableOrderEdits = async (printRevisedKot: boolean) => {
    if (isRetail || orderType !== 'dine_in' || !activeTableSession || !editingTableOrder) return;

    if (editTableItems.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setCheckoutError(`Maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct items per table.`);
      return;
    }

    const isCancellingTable = editTableItems.length === 0;
    if (!isCancellingTable && activeEmployees.length > 0 && !resolvedEmployeeId) {
      setCheckoutError('Please select the Employee handling this table.');
      return;
    }

    // Verify sufficient stock for any increased/newly added items
    for (const d of tableOrderDiff) {
      if (d.delta > 0) {
        const prod = products.find((p) => p.id === d.productId);
        if (prod && prod.stock < d.delta) {
          setCheckoutError(
            `Only ${prod.stock} extra ${prod.unit} available in stock for ${prod.name}.`
          );
          return;
        }
      }
    }

    setProcessing(true);
    setCheckoutError(null);

    const tableNum = activeTableSession.tableNumber;
    const tablePath = `stores/${store.id}/tables/${activeTableSession.id}`;
    const cleanGuest = customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    const finalEmpId = resolvedEmployeeId.slice(0, 128);
    const finalEmpName = resolvedEmployeeName.slice(0, BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX);

    const changeNotes = tableOrderDiff.map((d) =>
      d.delta > 0
        ? `+${d.delta}x ${d.name}`
        : d.draftQty === 0
        ? `CANCELLED ${Math.abs(d.delta)}x ${d.name}`
        : `${d.delta}x ${d.name} (now ${d.draftQty}x)`
    );

    try {
      const batch = writeBatch(db);
      const tableRef = doc(db, 'stores', store.id, 'tables', activeTableSession.id);

      // Reconcile inventory stock for every changed item (restore on reduction, deduct on addition)
      tableOrderDiff.forEach((d, idx) => {
        const prod = products.find((p) => p.id === d.productId);
        if (!prod) return;
        const currentStock = Number.isFinite(Number(prod.stock)) ? Number(prod.stock) : 0;
        const nextStock = Math.max(
          0,
          Math.min(10000000, Number((currentStock - d.delta).toFixed(2)))
        );
        batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = `${generateSafeId('log')}_${idx}`;
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: String(prod.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: Number((-d.delta).toFixed(2)),
          previousStock: currentStock,
          newStock: nextStock,
          reason: d.delta > 0 ? 'sale' : 'adjustment',
          note: (isCancellingTable
            ? `Cancelled Table ${tableNum}${finalEmpName ? ` by ${finalEmpName}` : ''}`
            : d.delta > 0
            ? `Table ${tableNum} edit (+${d.delta})${finalEmpName ? ` by ${finalEmpName}` : ''}`
            : `Table ${tableNum} edit (${d.delta})${finalEmpName ? ` by ${finalEmpName}` : ''}`
          ).slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      });

      const sanitizedItems: SaleItem[] = editTableItems.map((item) => {
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
          barcode: isRetail ? String(item.barcode ?? '').slice(0, BLUEPRINT_LIMITS.BARCODE_MAX) : '',
        };
      });

      if (isCancellingTable) {
        batch.delete(tableRef);
      } else {
        const nextCount = sanitizedItems.reduce((acc, i) => acc + i.quantity, 0);
        const nextSubtotal = Number(
          sanitizedItems.reduce((acc, i) => acc + i.lineTotal, 0).toFixed(2)
        );
        const nextCost = Number(
          sanitizedItems.reduce((acc, i) => acc + i.costPrice * i.quantity, 0).toFixed(2)
        );

        batch.update(tableRef, {
          items: sanitizedItems,
          itemCount: nextCount,
          subtotal: nextSubtotal,
          totalCost: nextCost,
          customerName: cleanGuest,
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      const revisedKotPreview: Sale | null =
        printRevisedKot && !isCancellingTable
          ? {
              id: `kot_rev_${Date.now()}`,
              ownerId,
              storeId: store.id,
              invoiceNumber: `KOT-REV-T${tableNum}`,
              dateKey: getTodayDateKey(),
              items: sanitizedItems,
              itemCount: sanitizedItems.reduce((a, i) => a + i.quantity, 0),
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
              employeeId: finalEmpId,
              employeeName: finalEmpName,
              status: 'completed',
              createdAt: null,
              updatedAt: null,
            }
          : null;

      clearCart(false);
      setMobileCartOpen(false);
      showTempNotice(
        isCancellingTable
          ? `Table ${tableNum} order cancelled & stock restored — table is now Empty.`
          : `Table ${tableNum} order updated & stock adjusted.`
      );

      if (revisedKotPreview) {
        onPrintJob({
          type: 'kot',
          sale: revisedKotPreview,
          isRevised: true,
          changeNotes,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save table order update.';
      setCheckoutError(`Could not save table update: ${msg}`);
      try {
        handleFirestoreError(
          err,
          isCancellingTable ? OperationType.DELETE : OperationType.UPDATE,
          tablePath
        );
      } catch {
        // Error already logged with structured context and displayed in checkoutError
      }
    } finally {
      setProcessing(false);
    }
  };

  /**
   * Complete Final Bill (works for Retail, Takeaway, Delivery, Empty Dine-In, and Settling Occupied Dine-In Tables)
   */
  const handleCheckout = async (autoPrint: boolean) => {
    if (combinedItems.length === 0) {
      setCheckoutError('Add at least one item to create a bill.');
      return;
    }
    if (combinedItems.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setCheckoutError(`Maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct line items per bill.`);
      return;
    }

    const effectiveOrderType: OrderType = isRetail
      ? 'retail'
      : orderType === 'retail'
      ? 'dine_in'
      : orderType;

    const cleanName = customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX);
    const cleanPhone = customerPhone.trim().slice(0, BLUEPRINT_LIMITS.PHONE_MAX);
    const cleanPhoneDigits = normalizePhoneDigits(cleanPhone);
    const cleanAddress = customerAddress.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_ADDRESS_MAX);

    // Order-type specific required field checks
    if (!isRetail) {
      if (effectiveOrderType === 'dine_in' && !tableNumber) {
        setCheckoutError('Please select a Table from the dropdown for Dine-In billing.');
        return;
      }
      if (effectiveOrderType === 'dine_in' && activeEmployees.length > 0 && !resolvedEmployeeId) {
        setCheckoutError('Please select the Employee handling this table.');
        return;
      }
      if (effectiveOrderType === 'takeaway' && !cleanName) {
        setCheckoutError('Customer Name is required for Takeaway orders.');
        return;
      }
      if (effectiveOrderType === 'delivery') {
        if (!cleanPhone || cleanPhoneDigits.length < 4) {
          setCheckoutError('Valid Phone Number is required for Delivery orders.');
          return;
        }
        if (!cleanName) {
          setCheckoutError('Customer Name is required for Delivery orders.');
          return;
        }
        if (!cleanAddress) {
          setCheckoutError('Delivery Address is required for Delivery orders.');
          return;
        }
      }
    }

    if (paymentMethod === 'cash' && amountTenderedInput.trim() && parsedTendered < grandTotal) {
      setCheckoutError('Cash tendered is less than the grand total.');
      return;
    }

    setProcessing(true);
    setCheckoutError(null);

    const saleId = generateSafeId('sale');
    const invoiceNumber = generateInvoiceNumber(store.name);
    const dateKey = getTodayDateKey();
    const netProfit = Number((grandTotal - taxAmount - totalCost).toFixed(2));
    const salePath = `stores/${store.id}/sales/${saleId}`;
    const finalEmpId = (resolvedEmployeeId || activeTableSession?.employeeId || '').slice(0, 128);
    const finalEmpName = (resolvedEmployeeName || activeTableSession?.employeeName || '').slice(
      0,
      BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX
    );

    try {
      const batch = writeBatch(db);
      const saleRef = doc(db, 'stores', store.id, 'sales', saleId);

      batch.set(saleRef, {
        ownerId,
        storeId: store.id,
        invoiceNumber,
        dateKey,
        items: combinedItems,
        itemCount: totalItemsCount,
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        taxRate: effectiveTaxRate,
        taxAmount,
        total: grandTotal,
        totalCost: Number(totalCost.toFixed(2)),
        profit: netProfit,
        paymentMethod,
        amountTendered: Number(parsedTendered.toFixed(2)),
        changeDue,
        orderType: effectiveOrderType,
        tableNumber:
          !isRetail && effectiveOrderType === 'dine_in'
            ? tableNumber.trim().slice(0, BLUEPRINT_LIMITS.TABLE_MAX)
            : '',
        customerName: cleanName,
        customerPhone: cleanPhone,
        customerAddress: effectiveOrderType === 'delivery' ? cleanAddress : '',
        employeeId: finalEmpId,
        employeeName: finalEmpName,
        status: 'completed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      // Deduct stock ONLY for items currently in the unsaved cart (booked table items already deducted)
      for (const c of cart) {
        const nextStock = Math.max(0, Number((c.product.stock - c.quantity).toFixed(2)));
        const prodRef = doc(db, 'stores', store.id, 'products', c.product.id);
        batch.update(prodRef, {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = generateSafeId('log');
        const logRef = doc(db, 'stores', store.id, 'stockLogs', logId);
        batch.set(logRef, {
          ownerId,
          storeId: store.id,
          productId: c.product.id,
          productName: c.product.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -c.quantity,
          previousStock: c.product.stock,
          newStock: nextStock,
          reason: 'sale',
          note: `Invoice ${invoiceNumber}${finalEmpName ? ` by ${finalEmpName}` : ''}`.slice(
            0,
            BLUEPRINT_LIMITS.STOCK_NOTE_MAX
          ),
          createdAt: serverTimestamp(),
        });
      }

      // If settling an occupied dine-in table, clear the table so it becomes Empty
      if (activeTableSession) {
        batch.delete(doc(db, 'stores', store.id, 'tables', activeTableSession.id));
      }

      // Save or update Customer history whenever phone & name are provided (especially Delivery & Takeaway)
      if (!isRetail && cleanPhoneDigits.length >= 4 && cleanName) {
        const existingCust = customers.find((c) => c.phoneDigits === cleanPhoneDigits);
        const custId = existingCust ? existingCust.id : `cust_${cleanPhoneDigits}`;
        const custRef = doc(db, 'stores', store.id, 'customers', custId);
        if (existingCust) {
          batch.update(custRef, {
            name: cleanName,
            phone: cleanPhone,
            address: cleanAddress || existingCust.address || '',
            orderCount: existingCust.orderCount + 1,
            updatedAt: serverTimestamp(),
          });
        } else {
          batch.set(custRef, {
            ownerId,
            storeId: store.id,
            name: cleanName,
            phone: cleanPhone,
            phoneDigits: cleanPhoneDigits,
            address: cleanAddress,
            orderCount: 1,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();

      const completedSale: Sale = {
        id: saleId,
        ownerId,
        storeId: store.id,
        invoiceNumber,
        dateKey,
        items: combinedItems,
        itemCount: totalItemsCount,
        subtotal: Number(subtotal.toFixed(2)),
        discount: Number(discount.toFixed(2)),
        taxRate: effectiveTaxRate,
        taxAmount,
        total: grandTotal,
        totalCost: Number(totalCost.toFixed(2)),
        profit: netProfit,
        paymentMethod,
        amountTendered: Number(parsedTendered.toFixed(2)),
        changeDue,
        orderType: effectiveOrderType,
        tableNumber: !isRetail && effectiveOrderType === 'dine_in' ? tableNumber.trim() : '',
        customerName: cleanName,
        customerPhone: cleanPhone,
        customerAddress: effectiveOrderType === 'delivery' ? cleanAddress : '',
        employeeId: finalEmpId,
        employeeName: finalEmpName,
        status: 'completed',
        createdAt: null,
        updatedAt: null,
      };

      setLastCompletedSale(completedSale);
      clearCart(false);
      setMobileCartOpen(false);
      if (autoPrint) {
        onPrintJob({ type: 'receipt', sale: completedSale });
      } else {
        showTempNotice(
          activeTableSession
            ? `Table ${activeTableSession.tableNumber} settled and cleared to Empty.`
            : `Bill ${invoiceNumber} saved.`
        );
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, salePath);
    } finally {
      setProcessing(false);
    }
  };

  const renderCartPanel = () => (
    <div className="flex flex-col max-h-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {activeTableSession ? `Table ${activeTableSession.tableNumber} · Occupied` : 'Current Bill'}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
            {activeTableSession && cart.length > 0 ? ` (${cart.length} new add-on)` : ''}
            {activeTableSession?.employeeName ? ` · ${activeTableSession.employeeName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeTableSession && !editingTableOrder && (
            <button
              type="button"
              onClick={startEditingTableOrder}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/70 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/80 whitespace-nowrap cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5 shrink-0" />
              <span>Edit Order</span>
            </button>
          )}
          {cart.length > 0 && !editingTableOrder && (
            <button
              type="button"
              onClick={() => clearCart(!!activeTableSession)}
              className="text-xs font-medium text-slate-500 hover:text-red-600 dark:hover:text-red-400 px-2 py-1 cursor-pointer"
            >
              {activeTableSession ? 'Clear Add-Ons' : 'Clear'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setMobileCartOpen(false)}
            className="lg:hidden rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close cart"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Order Mode & Customer Details */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5 bg-slate-50/70 dark:bg-slate-950/40 shrink-0">
        {!isRetail && (
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
            {(
              [
                { id: 'dine_in', label: 'Dine-In' },
                { id: 'takeaway', label: 'Takeaway' },
                { id: 'delivery', label: 'Delivery' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleOrderTypeSwitch(opt.id)}
                className={`flex-1 py-1.5 px-2 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  orderType === opt.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {/* DINE-IN: Table Status Dropdown (Empty vs Occupied) */}
        {!isRetail && orderType === 'dine_in' && (
          <div className="space-y-2">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="dinein-table-select"
                  className="block text-[11px] font-medium text-slate-600 dark:text-slate-400"
                >
                  Select Table *
                </label>
                {tableNumber && (
                  <button
                    type="button"
                    onClick={() => handleTableSelect('')}
                    className="text-[11px] font-medium text-slate-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                  >
                    Unselect Table
                  </button>
                )}
              </div>
              <select
                id="dinein-table-select"
                value={tableNumber}
                onChange={(e) => handleTableSelect(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-900 dark:text-slate-100"
              >
                <option value="">-- Select Table --</option>
                {tableNumbersList.map((num) => {
                  const session = tableSessionMap.get(num);
                  return (
                    <option key={num} value={num}>
                      {session
                        ? `Table ${num} — Occupied (${
                            session.employeeName ? `${session.employeeName} · ` : ''
                          }${session.itemCount} items · ${formatMoney(
                            session.subtotal,
                            store.currency
                          )})`
                        : `Table ${num} — Empty`}
                    </option>
                  );
                })}
              </select>
            </div>

            <input
              type="text"
              maxLength={BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX}
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Guest name / note (optional)"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
            />
          </div>
        )}

        {/* TAKEAWAY: Customer Name (Required) + Phone (Optional) */}
        {!isRetail && orderType === 'takeaway' && (
          <div className="space-y-2">
            <div className="relative">
              <User className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                maxLength={BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX}
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Customer Name * (Required)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="relative">
              <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="tel"
                maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                value={customerPhone}
                onChange={(e) => handlePhoneChange(e.target.value)}
                placeholder="Phone Number (Optional)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
        )}

        {/* DELIVERY: Phone (Required, Auto-Fill from History) + Name (Required) + Address (Required, Editable) */}
        {!isRetail && orderType === 'delivery' && (
          <div className="space-y-2">
            <div className="relative">
              <Phone className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="tel"
                required
                maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                value={customerPhone}
                onChange={(e) => handlePhoneChange(e.target.value)}
                placeholder="Phone Number * (Auto-fills saved customer)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100"
              />
            </div>

            {matchedCustomer && (
              <div className="flex items-center justify-between gap-2 text-[11px] text-emerald-700 dark:text-emerald-400 px-1">
                <span>
                  Saved customer · {matchedCustomer.orderCount}{' '}
                  {matchedCustomer.orderCount === 1 ? 'order' : 'orders'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingAddress(true);
                    window.setTimeout(() => addressInputRef.current?.focus(), 40);
                  }}
                  className="inline-flex items-center gap-1 font-semibold brand-text hover:underline cursor-pointer"
                >
                  <Edit3 className="w-3 h-3" />
                  <span>Edit Address</span>
                </button>
              </div>
            )}

            <div className="relative">
              <User className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                required
                maxLength={BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX}
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Customer Name * (Required)"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="space-y-1.5">
              <div className="relative">
                <MapPin className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
                <textarea
                  ref={addressInputRef}
                  rows={2}
                  required
                  maxLength={BLUEPRINT_LIMITS.CUSTOMER_ADDRESS_MAX}
                  value={customerAddress}
                  readOnly={!!matchedCustomer && !editingAddress}
                  onChange={(e) => setCustomerAddress(e.target.value)}
                  placeholder="Delivery Address * (House, Street, Area)"
                  className={`w-full rounded-lg border pl-8 pr-3 py-2 text-xs text-slate-900 dark:text-slate-100 resize-none ${
                    matchedCustomer && !editingAddress
                      ? 'border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
                  }`}
                />
              </div>

              {matchedCustomer && editingAddress && (
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCustomerAddress(matchedCustomer.address);
                      setEditingAddress(false);
                    }}
                    className="text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-2 py-1 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={updatingAddress}
                    onClick={() => void handleSaveUpdatedCustomerAddress()}
                    className="inline-flex items-center gap-1 rounded-md brand-bg px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
                  >
                    <Check className="w-3 h-3" />
                    <span>{updatingAddress ? 'Updating...' : 'Update Saved Address'}</span>
                  </button>
                </div>
              )}

              {addressSavedNotice && (
                <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 px-1">
                  Customer delivery address updated in history.
                </div>
              )}
            </div>
          </div>
        )}

        {/* RETAIL: Optional Customer Name */}
        {isRetail && (
          <input
            type="text"
            maxLength={BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX}
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="Customer name (optional)"
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
          />
        )}

        {/* HANDLED BY (EMPLOYEE) DROPDOWN FOR STAFF ACCOUNTABILITY */}
        <div className="pt-1 border-t border-slate-200/80 dark:border-slate-800/80">
          <div className="flex items-center justify-between gap-2 mb-1">
            <label
              htmlFor="pos-employee-select"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-400"
            >
              <UserCheck className="w-3 h-3 text-slate-400" />
              <span>
                Handled By (Employee)
                {!isRetail && orderType === 'dine_in' && activeEmployees.length > 0 ? ' *' : ''}
              </span>
            </label>
            <button
              type="button"
              onClick={onGoToEmployees}
              className="text-[11px] font-semibold brand-text hover:underline cursor-pointer"
            >
              {activeEmployees.length === 0 ? '+ Add Staff' : 'Manage Staff'}
            </button>
          </div>
          <select
            id="pos-employee-select"
            value={selectedEmployeeId}
            onChange={(e) => {
              setSelectedEmployeeId(e.target.value);
              setCheckoutError(null);
            }}
            className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-900 dark:text-slate-100"
          >
            <option value="">
              {activeEmployees.length === 0
                ? '-- No staff added yet (click + Add Staff) --'
                : '-- Select Employee --'}
            </option>
            {selectedEmployeeId &&
              !activeEmployees.some((e) => e.id === selectedEmployeeId) &&
              resolvedEmployeeName && (
                <option value={selectedEmployeeId}>
                  {resolvedEmployeeName} (Inactive)
                </option>
              )}
            {activeEmployees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name} — {emp.role}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Items List (Shows Existing Booked Items on Occupied Table + New Cart / Add-On Items OR Edit Table Mode) */}
      <div className="flex-1 min-h-[170px] overflow-y-auto px-4">
        {activeTableSession && editingTableOrder ? (
          <div className="py-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2 pb-2 border-b border-amber-200 dark:border-amber-900/60">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  Editing Table {activeTableSession.tableNumber} Order
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {hasTableEditChanges
                    ? 'Click Save below to update this table'
                    : 'Reduce, remove, or tap dishes on left'}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {(hasTableEditChanges || editTableItems.length === 0) && (
                  <button
                    type="button"
                    disabled={processing}
                    onClick={() => void handleSaveTableOrderEdits(false)}
                    className="rounded-md brand-bg px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50 cursor-pointer"
                  >
                    {processing ? 'Saving...' : editTableItems.length === 0 ? 'Cancel Table' : 'Save'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelEditingTableOrder}
                  className="text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 px-1.5 py-1 cursor-pointer"
                >
                  Discard
                </button>
              </div>
            </div>

            {editTableItems.length === 0 ? (
              <div className="py-6 text-center space-y-1.5 rounded-lg border border-dashed border-red-300 dark:border-red-900/60 bg-red-50/50 dark:bg-red-950/20 px-3">
                <p className="text-xs font-semibold text-red-700 dark:text-red-300">
                  All items removed from Table {activeTableSession.tableNumber}
                </p>
                <p className="text-[11px] text-slate-600 dark:text-slate-400">
                  Tap dishes on the left to add replacement items, or click Cancel Table below to mark it Empty and restore stock.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {editTableItems.map((item) => (
                  <div key={item.productId} className="py-2.5 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                        {item.name}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                        {formatMoney(item.unitPrice, store.currency)} × {item.quantity}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => updateEditTableItemQty(item.productId, -1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        aria-label={`Decrease ${item.name}`}
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="w-7 text-center text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateEditTableItemQty(item.productId, 1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        aria-label={`Increase ${item.name}`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeEditTableItem(item.productId)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                        aria-label={`Remove ${item.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tableOrderDiff.length > 0 && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 space-y-1">
                <div className="text-[11px] font-semibold text-amber-900 dark:text-amber-300">
                  Order Changes (Stock auto-adjusts):
                </div>
                <div className="space-y-0.5 text-[11px] font-mono">
                  {tableOrderDiff.map((d) => (
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
                        ? `Removed ${Math.abs(d.delta)}× ${d.name}`
                        : `${d.delta}× ${d.name} (now ${d.draftQty}×)`}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {activeTableSession && (
              <div className="py-3 border-b border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                      Already Ordered on Table {activeTableSession.tableNumber}
                    </div>
                    <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {activeTableSession.itemCount}{' '}
                      {activeTableSession.itemCount === 1 ? 'item' : 'items'} ·{' '}
                      {formatMoney(activeTableSession.subtotal, store.currency)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={startEditingTableOrder}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-[11px] font-semibold text-slate-800 dark:text-slate-100 hover:border-amber-500 hover:text-amber-700 dark:hover:text-amber-300 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Edit3 className="w-3 h-3 shrink-0" />
                    <span>Edit Order</span>
                  </button>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {activeTableSession.items.map((item, idx) => (
                    <div
                      key={`${item.productId}-${idx}`}
                      className="py-2 flex items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-200"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{item.name}</div>
                        <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                          {formatMoney(item.unitPrice, store.currency)} × {item.quantity} ={' '}
                          {formatMoney(item.lineTotal, store.currency)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditingAndAdjustItem(item.productId, -1)}
                          className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-red-50 hover:border-red-300 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400 cursor-pointer"
                          aria-label={`Decrease ${item.name} on table`}
                          title="Reduce quantity"
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="w-6 text-center text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() => startEditingAndAdjustItem(item.productId, 1)}
                          className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          aria-label={`Increase ${item.name} on table`}
                          title="Increase quantity"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => startEditingAndAdjustItem(item.productId, 0, true)}
                          className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                          aria-label={`Remove ${item.name} from table`}
                          title="Remove item"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cart.length === 0 ? (
              <div className="py-10 text-center space-y-2">
                <ShoppingBag className="w-6 h-6 mx-auto text-slate-300 dark:text-slate-600" />
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {activeTableSession ? 'Ready for Add-Ons, Edit, or Settlement' : 'No items in bill'}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {activeTableSession
                    ? 'Tap dishes on the left to add extras, click Edit Order above to reduce/change items, or settle the bill below.'
                    : isRetail
                    ? 'Tap a product or scan a barcode to start billing.'
                    : 'Tap menu dishes on the left to build this order.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {activeTableSession && (
                  <div className="pt-2.5 pb-1 text-[11px] font-semibold brand-text">
                    New Add-On Items
                  </div>
                )}
                {cart.map(({ product, quantity }) => (
                  <div key={product.id} className="py-3 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                        {product.name}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                        {formatMoney(product.sellingPrice, store.currency)} × {quantity}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => updateCartQty(product.id, -1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        aria-label={`Decrease ${product.name}`}
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="w-7 text-center text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                        {quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateCartQty(product.id, 1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        aria-label={`Increase ${product.name}`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFromCart(product.id)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                        aria-label={`Remove ${product.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Totals & Checkout Controls */}
      <div className="border-t border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/70 dark:bg-slate-950/50 shrink-0">
        {activeTableSession && editingTableOrder ? (
          <div className="flex items-center justify-between text-sm font-bold text-slate-900 dark:text-slate-100">
            <span>Updated Table Subtotal</span>
            <span className="font-mono tabular-nums">{formatMoney(subtotal, store.currency)}</span>
          </div>
        ) : (
          <>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between text-slate-600 dark:text-slate-400">
                <span>Subtotal</span>
                <span className="font-mono tabular-nums">{formatMoney(subtotal, store.currency)}</span>
              </div>

              {/* Tax (%) right after Subtotal: pre-fills store default or allows manual override / 0% */}
              <div className="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
                <div className="flex items-center gap-1.5 min-w-0">
                  <label htmlFor="pos-tax-input" className="whitespace-nowrap">
                    Tax (%)
                  </label>
                  {effectiveTaxRate !== 0 && (
                    <button
                      type="button"
                      onClick={() => setTaxRateInput('0')}
                      className="text-[10px] font-medium text-slate-500 hover:text-red-600 dark:hover:text-red-400 underline cursor-pointer"
                      title="Set tax to 0%"
                    >
                      0%
                    </button>
                  )}
                  {store.taxRate > 0 && effectiveTaxRate !== store.taxRate && (
                    <button
                      type="button"
                      onClick={() => setTaxRateInput(String(store.taxRate))}
                      className="text-[10px] font-medium brand-text hover:underline whitespace-nowrap cursor-pointer"
                      title={`Use default store tax (${store.taxRate}%)`}
                    >
                      Default ({store.taxRate}%)
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="relative flex items-center">
                    <input
                      id="pos-tax-input"
                      type="number"
                      min="0"
                      max="50"
                      step="any"
                      value={taxRateInput}
                      onChange={(e) => setTaxRateInput(e.target.value)}
                      placeholder="0"
                      className="w-16 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-2 pr-5 py-1 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
                    />
                    <span className="absolute right-1.5 text-[10px] text-slate-400 pointer-events-none">
                      %
                    </span>
                  </div>
                  <span className="min-w-[68px] text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                    {formatMoney(taxAmount, store.currency)}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
                <label htmlFor="pos-discount-input">Discount ({store.currency})</label>
                <input
                  id="pos-discount-input"
                  type="number"
                  min="0"
                  step="any"
                  value={discountInput}
                  onChange={(e) => setDiscountInput(e.target.value)}
                  className="w-24 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800 text-base font-bold text-slate-900 dark:text-slate-100">
                <span>Total</span>
                <span className="font-mono tabular-nums">{formatMoney(grandTotal, store.currency)}</span>
              </div>
            </div>

            {/* Payment Method Selector */}
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: 'cash', label: 'Cash', icon: Banknote },
                  { id: 'card', label: 'Card', icon: CreditCard },
                  { id: 'bank_qr', label: 'Bank/QR', icon: QrCode },
                ] as const
              ).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setPaymentMethod(id);
                    setCheckoutError(null);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border py-2 px-2 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                    paymentMethod === id
                      ? 'brand-border brand-soft-bg brand-text'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* Cash Received & Change / Baqaya Calculator */}
            {paymentMethod === 'cash' && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <label
                    htmlFor="cash-tendered-input"
                    className="font-medium text-slate-700 dark:text-slate-300"
                  >
                    Cash Received ({store.currency})
                  </label>
                  <input
                    id="cash-tendered-input"
                    type="number"
                    min="0"
                    step="any"
                    value={amountTenderedInput}
                    onChange={(e) => {
                      setAmountTenderedInput(e.target.value);
                      setCheckoutError(null);
                    }}
                    placeholder={grandTotal > 0 ? grandTotal.toFixed(2) : '0.00'}
                    className="w-28 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-right font-mono font-semibold tabular-nums text-xs text-slate-900 dark:text-slate-100"
                  />
                </div>

                {quickCashSuggestions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {quickCashSuggestions.map((amt, idx) => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => {
                          setAmountTenderedInput(String(amt));
                          setCheckoutError(null);
                        }}
                        className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-mono tabular-nums text-slate-700 dark:text-slate-200 hover:border-slate-400 dark:hover:border-slate-500 cursor-pointer"
                      >
                        {idx === 0 ? 'Exact' : amt.toLocaleString()}
                      </button>
                    ))}
                    {amountTenderedInput && (
                      <button
                        type="button"
                        onClick={() => setAmountTenderedInput('')}
                        className="ml-auto text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                )}

                {grandTotal > 0 && (
                  cashShortfall > 0 ? (
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs font-semibold text-red-600 dark:text-red-400">
                      <span>Cash Short / Remaining</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(cashShortfall, store.currency)}
                      </span>
                    </div>
                  ) : (
                    <div
                      className={`flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs font-semibold ${
                        changeDue > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      <span>Change / Return (Baqaya)</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(changeDue, store.currency)}
                      </span>
                    </div>
                  )
                )}
              </div>
            )}
          </>
        )}

        {checkoutError && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
            {checkoutError}
          </div>
        )}

        {statusNotice && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
            {statusNotice}
          </div>
        )}

        {/* Action Buttons */}
        <div className="grid grid-cols-1 gap-2">
          {activeTableSession && editingTableOrder ? (
            editTableItems.length === 0 ? (
              <>
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => void handleSaveTableOrderEdits(false)}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  <span>
                    {processing
                      ? 'Cancelling...'
                      : `Cancel Table ${activeTableSession.tableNumber} Order (Mark Empty)`}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={processing}
                  onClick={cancelEditingTableOrder}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Discard Edit
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={processing || !hasTableEditChanges}
                  onClick={() => void handleSaveTableOrderEdits(true)}
                  className="w-full flex items-center justify-center gap-2 rounded-lg brand-bg px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 transition-opacity cursor-pointer"
                >
                  <Printer className="w-4 h-4 shrink-0" />
                  <span>
                    {processing
                      ? 'Saving Changes...'
                      : `Save Table ${activeTableSession.tableNumber} & Print Revised KOT`}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={processing || !hasTableEditChanges}
                  onClick={() => void handleSaveTableOrderEdits(false)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
                >
                  Save Changes Without Printing
                </button>
                <button
                  type="button"
                  disabled={processing}
                  onClick={cancelEditingTableOrder}
                  className="w-full rounded-lg px-4 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                >
                  Discard Edit
                </button>
              </>
            )
          ) : (
            <>
              {/* Dine-In Hold / Add-On Table Button */}
              {!isRetail && orderType === 'dine_in' && tableNumber && (
                <button
                  type="button"
                  disabled={processing || cart.length === 0}
                  onClick={() => void handleBookOrAddOnTable()}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-600 dark:border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/70 disabled:opacity-45 transition-colors cursor-pointer"
                >
                  <Utensils className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {activeTableSession
                      ? `Add Extras to Table ${tableNumber} & Print Add-On KOT`
                      : `Book Table ${tableNumber} & Print KOT`}
                  </span>
                </button>
              )}

              <button
                type="button"
                disabled={processing || combinedItems.length === 0}
                onClick={() => void handleCheckout(true)}
                className="w-full flex items-center justify-center gap-2 rounded-lg brand-bg px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 transition-opacity cursor-pointer"
              >
                <Printer className="w-4 h-4 shrink-0" />
                <span>
                  {processing
                    ? 'Completing...'
                    : activeTableSession
                    ? `Settle Table ${activeTableSession.tableNumber} & Print Bill`
                    : 'Complete & Print Bill'}
                </span>
              </button>

              <button
                type="button"
                disabled={processing || combinedItems.length === 0}
                onClick={() => void handleCheckout(false)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
              >
                {activeTableSession
                  ? `Settle Table ${activeTableSession.tableNumber} Without Printing`
                  : 'Save Sale Without Printing'}
              </button>
            </>
          )}
        </div>

        {lastCompletedSale && (
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
            <span className="text-slate-600 dark:text-slate-400 truncate">
              Last: <strong className="font-mono">{lastCompletedSale.invoiceNumber}</strong>
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onPrintJob({ type: 'receipt', sale: lastCompletedSale })}
                className="font-medium brand-text hover:underline cursor-pointer"
              >
                Reprint Bill
              </button>
              {!isRetail && (
                <button
                  type="button"
                  onClick={() => onPrintJob({ type: 'kot', sale: lastCompletedSale })}
                  className="font-medium text-amber-700 dark:text-amber-400 hover:underline cursor-pointer"
                >
                  Print KOT
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start pb-20 lg:pb-0">
      {/* Left: Catalog & Controls */}
      <div className="lg:col-span-8 space-y-4">
        {/* Top Feedback & Live Table Edit Save Bar */}
        {statusNotice && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-3.5 py-2.5 text-xs font-medium text-emerald-800 dark:text-emerald-300">
            {statusNotice}
          </div>
        )}

        {checkoutError && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-xs font-medium text-red-700 dark:text-red-300">
            {checkoutError}
          </div>
        )}

        {activeTableSession && editingTableOrder && (
          <div className="rounded-xl border border-amber-400 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-bold text-amber-900 dark:text-amber-200">
                Editing Table {activeTableSession.tableNumber} Order
                {tableOrderDiff.length > 0 ? ` · ${tableOrderDiff.length} change(s) pending` : ''}
              </div>
              <div className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                {editTableItems.length === 0
                  ? 'All items removed — tap dishes below to replace or cancel this table.'
                  : 'Tap dishes below to add/swap, then click Save to update this table.'}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {editTableItems.length === 0 ? (
                <button
                  type="button"
                  disabled={processing}
                  onClick={() => void handleSaveTableOrderEdits(false)}
                  className="rounded-lg bg-red-600 hover:bg-red-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
                >
                  {processing ? 'Cancelling...' : `Cancel Table ${activeTableSession.tableNumber}`}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={processing || !hasTableEditChanges}
                    onClick={() => void handleSaveTableOrderEdits(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg brand-bg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>{processing ? 'Saving...' : 'Save & Revised KOT'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={processing || !hasTableEditChanges}
                    onClick={() => void handleSaveTableOrderEdits(false)}
                    className="rounded-lg border border-amber-600/50 dark:border-amber-600 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950 disabled:opacity-50 cursor-pointer"
                  >
                    Save Only
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={processing}
                onClick={cancelEditingTableOrder}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Search & Retail Barcode Scan Bar */}
        <div className={`grid gap-3 ${isRetail ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                isRetail ? 'Search products, SKU, or category...' : 'Search menu dishes or category...'
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-10 pr-4 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-300"
            />
          </div>

          {isRetail && (
            <form onSubmit={handleBarcodeScanSubmit} className="relative flex gap-2">
              <div className="relative flex-1">
                <Barcode className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={scanInputRef}
                  type="text"
                  value={barcodeScanInput}
                  onChange={(e) => setBarcodeScanInput(e.target.value)}
                  placeholder="Scan barcode & press Enter..."
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-10 pr-3 py-2.5 text-sm font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:focus:ring-slate-300"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Scan Add
              </button>
            </form>
          )}
        </div>

        {/* Occupied Tables Quick Strip for Restaurants */}
        {!isRetail && tableSessions.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
              Active Tables:
            </span>
            {tableSessions.map((session) => {
              const isSelected = orderType === 'dine_in' && tableNumber === session.tableNumber;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => {
                    if (isSelected) {
                      handleTableSelect('');
                    } else {
                      setOrderType('dine_in');
                      handleTableSelect(session.tableNumber);
                    }
                  }}
                  className={`px-3 py-1.5 rounded-lg border text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    isSelected
                      ? 'brand-border brand-soft-bg brand-text font-semibold'
                      : 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/60'
                  }`}
                >
                  Table {session.tableNumber}
                  {session.employeeName ? ` (${session.employeeName})` : ''} · {session.itemCount}{' '}
                  items ·{' '}
                  <span className="font-mono tabular-nums">
                    {formatMoney(session.subtotal, store.currency)}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {scanMessage && (
          <div
            className={`text-xs font-medium px-3.5 py-2 rounded-lg border ${
              scanMessage.type === 'ok'
                ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300'
                : 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'
            }`}
          >
            {scanMessage.text}
          </div>
        )}

        {/* Category Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                selectedCategory === cat
                  ? 'brand-bg text-white'
                  : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Product Grid */}
        {activeProducts.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              No {isRetail ? 'products' : 'menu items'} in your catalog yet
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Add items in Inventory to start generating bills, tracking stock, and exporting daily reports.
            </p>
            <button
              type="button"
              onClick={onGoToInventory}
              className="rounded-lg brand-bg px-4 py-2.5 text-sm font-medium text-white cursor-pointer"
            >
              Add First Item
            </button>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No items match your current filter.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredProducts.map((product) => {
              const inCart =
                editingTableOrder && activeTableSession
                  ? editTableItems.find((i) => i.productId === product.id)?.quantity ?? 0
                  : cart.find((c) => c.product.id === product.id)?.quantity ?? 0;
              const originalOnTable =
                activeTableSession
                  ? activeTableSession.items.find((i) => i.productId === product.id)?.quantity ?? 0
                  : 0;
              const displayQty =
                editingTableOrder && activeTableSession ? inCart : inCart > 0 ? inCart : 0;
              const canQuickDecrement =
                inCart > 0 || (!!activeTableSession && !editingTableOrder && originalOnTable > 0);
              const availableStock =
                editingTableOrder && activeTableSession
                  ? product.stock + Math.max(0, originalOnTable - inCart)
                  : product.stock;
              const isOut = availableStock <= 0;
              const isLow = product.stock > 0 && product.stock <= product.minStock;

              const handleCardDecrement = (e: React.MouseEvent) => {
                e.stopPropagation();
                if (editingTableOrder && activeTableSession) {
                  updateEditTableItemQty(product.id, -1);
                } else if (inCart > 0) {
                  updateCartQty(product.id, -1);
                } else if (activeTableSession && originalOnTable > 0) {
                  startEditingAndAdjustItem(product.id, -1);
                }
              };

              const handleCardIncrement = (e: React.MouseEvent) => {
                e.stopPropagation();
                if (!isOut) addToCart(product);
              };

              return (
                <div
                  key={product.id}
                  role="button"
                  tabIndex={isOut && !canQuickDecrement ? -1 : 0}
                  onClick={() => {
                    if (!isOut) addToCart(product);
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !isOut) {
                      e.preventDefault();
                      addToCart(product);
                    }
                  }}
                  className={`group text-left rounded-xl border p-3.5 transition-all flex flex-col justify-between min-h-[124px] select-none ${
                    isOut && !canQuickDecrement ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer'
                  } ${
                    displayQty > 0 || originalOnTable > 0
                      ? 'brand-border brand-soft-bg'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-600'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug line-clamp-2">
                        {product.name}
                      </span>
                      {displayQty > 0 && (
                        <span className="text-xs font-mono font-bold brand-text shrink-0">
                          ×{displayQty}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
                      {product.category}
                      {isRetail && product.sku ? ` · ${product.sku}` : ''}
                      {!editingTableOrder && originalOnTable > 0 ? ` · On Table: ${originalOnTable}×` : ''}
                    </div>
                  </div>

                  {canQuickDecrement ? (
                    <div className="mt-3 pt-2 border-t border-slate-200/80 dark:border-slate-700/80 flex items-center justify-between gap-2">
                      <span className="text-xs font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 truncate">
                        {formatMoney(product.sellingPrice, store.currency)}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={handleCardDecrement}
                          className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-800 dark:text-slate-100 hover:border-red-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                          aria-label={`Decrease ${product.name}`}
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-6 text-center text-xs font-mono font-bold tabular-nums text-slate-900 dark:text-slate-100">
                          {editingTableOrder
                            ? inCart
                            : originalOnTable + inCart}
                        </span>
                        <button
                          type="button"
                          disabled={isOut}
                          onClick={handleCardIncrement}
                          className="w-7 h-7 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 flex items-center justify-center text-slate-800 dark:text-slate-100 hover:border-slate-500 disabled:opacity-40 cursor-pointer"
                          aria-label={`Increase ${product.name}`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-baseline justify-between gap-2">
                      <span className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        {formatMoney(product.sellingPrice, store.currency)}
                      </span>
                      <span
                        className={`text-[11px] font-mono tabular-nums ${
                          isOut
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : isLow
                            ? 'text-amber-600 dark:text-amber-400 font-medium'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {isOut ? 'Out' : `${product.stock} ${product.unit}`}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Desktop Sticky Cart Panel */}
      <div className="hidden lg:block lg:col-span-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-5.5rem)]">
        {renderCartPanel()}
      </div>

      {/* Mobile Bottom Checkout Bar */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 no-print">
        <button
          type="button"
          onClick={() => setMobileCartOpen(true)}
          className="w-full flex items-center justify-between rounded-lg brand-bg px-4 py-3 text-sm font-semibold text-white cursor-pointer"
        >
          <span>
            {activeTableSession
              ? `Table ${activeTableSession.tableNumber} (${totalItemsCount} items)`
              : `View Bill (${totalItemsCount} ${totalItemsCount === 1 ? 'item' : 'items'})`}
          </span>
          <span className="font-mono tabular-nums">{formatMoney(grandTotal, store.currency)}</span>
        </button>
      </div>

      {/* Mobile Slide-Over Cart Modal */}
      {mobileCartOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-slate-950/65 flex justify-end p-2">
          <div className="w-full max-w-md h-full">{renderCartPanel()}</div>
        </div>
      )}
    </div>
  );
};
