import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Banknote,
  Barcode,
  Bell,
  Check,
  CheckCheck,
  ChefHat,
  CreditCard,
  Edit3,
  MapPin,
  Minus,
  Phone,
  Plus,
  Printer,
  QrCode,
  Receipt,
  Search,
  ShoppingBag,
  StickyNote,
  Trash2,
  User,
  UserCheck,
  Utensils,
  Wallet,
  X,
} from 'lucide-react';
import { doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  BLUEPRINT_LIMITS,
  type CartItem,
  type Customer,
  type Employee,
  type KotKitchenStatus,
  type KotTicket,
  type OrderType,
  type PaymentMethod,
  type PrintJob,
  type Product,
  type ProductVariant,
  type Sale,
  type SaleItem,
  type StoreConfig,
  type TableSession,
} from '../types';
import {
  computeSplitPaymentSettlement,
  formatDailyToken,
  formatDishNameWithVariant,
  formatMoney,
  generateInvoiceNumber,
  generateSafeId,
  getLineItemKey,
  getTodayDateKey,
  isProductStockTracked,
  KITCHEN_QUICK_NOTES,
} from '../utils/posHelpers';

interface BillingViewProps {
  store: StoreConfig;
  products: Product[];
  sales?: Sale[];
  tableSessions: TableSession[];
  kotTickets?: KotTicket[];
  customers: Customer[];
  employees: Employee[];
  ownerId: string;
  onPrintJob: (job: PrintJob) => void;
  onUpdateKitchenStatus?: (kotId: string, nextStatus: KotKitchenStatus) => Promise<void>;
  onGoToInventory: () => void;
  onGoToEmployees: () => void;
}

function normalizePhoneDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 24);
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

export const BillingView: React.FC<BillingViewProps> = ({
  store,
  products,
  sales = [],
  tableSessions,
  kotTickets = [],
  customers,
  employees,
  ownerId,
  onPrintJob,
  onUpdateKitchenStatus,
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
  const [serviceChargeRateInput, setServiceChargeRateInput] = useState<string>(
    String(!isRetail ? store.serviceChargeRate ?? 0 : 0)
  );
  const [deliveryFeeInput, setDeliveryFeeInput] = useState<string>('0');
  const [discountInput, setDiscountInput] = useState<string>('0');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [amountTenderedInput, setAmountTenderedInput] = useState<string>('');
  const [splitCashInput, setSplitCashInput] = useState<string>('');
  const [splitCardInput, setSplitCardInput] = useState<string>('');
  const [splitBankQrInput, setSplitBankQrInput] = useState<string>('');
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
  const [draftTokenNumber, setDraftTokenNumber] = useState<number | null>(null);
  const [draftKotSent, setDraftKotSent] = useState<boolean>(false);
  const [sendKotOnTakeawayDelivery, setSendKotOnTakeawayDelivery] = useState<boolean>(true);

  const [editingTableOrder, setEditingTableOrder] = useState<boolean>(false);
  const [editTableItems, setEditTableItems] = useState<SaleItem[]>([]);

  // Size/Variant & Kitchen Note modals (Restaurant mode)
  const [pickerProduct, setPickerProduct] = useState<Product | null>(null);
  const [pickerVariantId, setPickerVariantId] = useState<string>('');
  const [pickerNote, setPickerNote] = useState<string>('');
  const [pickerQty, setPickerQty] = useState<number>(1);
  const [noteTarget, setNoteTarget] = useState<{
    mode: 'cart' | 'edit_table';
    lineKey: string;
    title: string;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState<string>('');

  // Table Transfer / Merge modal state
  const [transferModalOpen, setTransferModalOpen] = useState<boolean>(false);
  const [transferTargetTable, setTransferTargetTable] = useState<string>('');
  const [transferNotifyKot, setTransferNotifyKot] = useState<boolean>(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const [processing, setProcessing] = useState(false);
  const [busyKotId, setBusyKotId] = useState<string | null>(null);
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

  useEffect(() => {
    if (isRetail) {
      setServiceChargeRateInput('0');
      setDeliveryFeeInput('0');
      return;
    }
    if (orderType === 'dine_in') {
      setServiceChargeRateInput(String(store.serviceChargeRate ?? 0));
    }
  }, [store.id, store.serviceChargeRate, isRetail, orderType]);

  useEffect(() => {
    if (!isRetail && orderType === 'delivery') {
      setDeliveryFeeInput(String(store.defaultDeliveryFee ?? 0));
    }
  }, [store.id, store.defaultDeliveryFee, isRetail, orderType]);

  const tableSessionMap = useMemo(() => {
    const map = new Map<string, TableSession>();
    tableSessions.forEach((t) => map.set(t.tableNumber, t));
    return map;
  }, [tableSessions]);

  const activeTableSession = useMemo(() => {
    if (isRetail || orderType !== 'dine_in' || !tableNumber) return null;
    return tableSessionMap.get(tableNumber) ?? null;
  }, [isRetail, orderType, tableNumber, tableSessionMap]);

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

  const activeTableKots = useMemo(() => {
    if (!activeTableSession) return [];
    return kotTickets
      .filter(
        (t) =>
          t.tableNumber === activeTableSession.tableNumber &&
          t.ticketKind !== 'reprint' &&
          t.kitchenStatus !== 'served'
      )
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
  }, [kotTickets, activeTableSession]);

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

  const formatFirestoreActionError = (err: unknown, fallback: string) => {
    const rawMsg = err instanceof Error ? err.message : String(err ?? '');
    if (rawMsg.toLowerCase().includes('permission')) {
      return 'Firestore permission denied: please publish the latest firestore.rules in Firebase Console → Firestore Database → Rules.';
    }
    return rawMsg || fallback;
  };

  const handleUpdateTableKotStatus = async (kotId: string, nextStatus: KotKitchenStatus) => {
    if (!onUpdateKitchenStatus) return;
    setBusyKotId(kotId);
    setCheckoutError(null);
    try {
      await onUpdateKitchenStatus(kotId, nextStatus);
    } catch (err) {
      setCheckoutError(
        formatFirestoreActionError(err, 'Unable to update kitchen order status.')
      );
    } finally {
      setBusyKotId(null);
    }
  };

  const handleOrderTypeSwitch = (nextType: OrderType) => {
    setOrderType(nextType);
    setCheckoutError(null);
    setEditingTableOrder(false);
    setEditTableItems([]);
    setDraftTokenNumber(null);
    setDraftKotSent(false);
    setServiceChargeRateInput(
      !isRetail && nextType === 'dine_in' ? String(store.serviceChargeRate ?? 0) : '0'
    );
    setDeliveryFeeInput(
      !isRetail && nextType === 'delivery' ? String(store.defaultDeliveryFee ?? 0) : '0'
    );
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

  const updateEditTableItemQty = (lineKey: string, delta: number) => {
    if (!activeTableSession) return;
    setCheckoutError(null);

    const targetItem = editTableItems.find((i) => getLineItemKey(i) === lineKey);
    if (!targetItem) return;

    if (delta > 0) {
      const product = products.find((p) => p.id === targetItem.productId);
      const originalTotalQty = activeTableSession.items
        .filter((i) => i.productId === targetItem.productId)
        .reduce((acc, i) => acc + i.quantity, 0);
      const currentDraftTotalQty = editTableItems
        .filter((i) => i.productId === targetItem.productId)
        .reduce((acc, i) => acc + i.quantity, 0);
      const netExtraNeeded = currentDraftTotalQty + delta - originalTotalQty;
      if (product && isProductStockTracked(product) && netExtraNeeded > product.stock) {
        setCheckoutError(
          `Only ${product.stock} extra ${product.unit} available in stock for ${product.name}.`
        );
        return;
      }
    }

    setEditTableItems((prev) =>
      prev
        .map((item) => {
          if (getLineItemKey(item) !== lineKey) return item;
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

  const removeEditTableItem = (lineKey: string) => {
    setCheckoutError(null);
    setEditTableItems((prev) => prev.filter((item) => getLineItemKey(item) !== lineKey));
  };

  const startEditingAndAdjustItem = (
    lineKey: string,
    delta: number,
    removeAll = false,
    openNoteAfter = false
  ) => {
    if (!activeTableSession) return;
    setCheckoutError(null);

    const baseDraft =
      cartSaleItems.length > 0
        ? mergeSaleItems(activeTableSession.items, cartSaleItems)
        : activeTableSession.items.map((item) => ({ ...item }));

    const targetItem = baseDraft.find((i) => getLineItemKey(i) === lineKey);

    if (delta > 0 && !removeAll && targetItem) {
      const product = products.find((p) => p.id === targetItem.productId);
      const originalTotalQty = activeTableSession.items
        .filter((i) => i.productId === targetItem.productId)
        .reduce((acc, i) => acc + i.quantity, 0);
      const currentDraftTotalQty = baseDraft
        .filter((i) => i.productId === targetItem.productId)
        .reduce((acc, i) => acc + i.quantity, 0);
      const netExtraNeeded = currentDraftTotalQty + delta - originalTotalQty;
      if (product && isProductStockTracked(product) && netExtraNeeded > product.stock) {
        setCheckoutError(
          `Only ${product.stock} extra ${product.unit} available in stock for ${product.name}.`
        );
        return;
      }
    }

    const nextDraft = removeAll
      ? baseDraft.filter((item) => getLineItemKey(item) !== lineKey)
      : delta === 0
      ? baseDraft
      : baseDraft
          .map((item) => {
            if (getLineItemKey(item) !== lineKey) return item;
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

    if (openNoteAfter && targetItem) {
      setNoteTarget({
        mode: 'edit_table',
        lineKey,
        title: targetItem.name,
      });
      setNoteDraft(targetItem.note || '');
    }
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

  const addConfiguredItem = (
    product: Product,
    variant?: ProductVariant,
    note?: string,
    qtyToAdd = 1
  ) => {
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

    // When editing an occupied table's order, add directly into the edit draft
    if (editingTableOrder && activeTableSession) {
      setCheckoutError(null);
      const originalTotalQty = activeTableSession.items
        .filter((i) => i.productId === product.id)
        .reduce((acc, i) => acc + i.quantity, 0);
      const currentDraftTotalQty = editTableItems
        .filter((i) => i.productId === product.id)
        .reduce((acc, i) => acc + i.quantity, 0);
      const netExtraNeeded = currentDraftTotalQty + qtyToAdd - originalTotalQty;

      if (tracked && netExtraNeeded > product.stock) {
        setCheckoutError(
          product.stock <= 0
            ? `${product.name} is out of stock.`
            : `Only ${product.stock} extra ${product.unit} available for ${product.name}.`
        );
        return;
      }

      setEditTableItems((prev) => {
        const existing = prev.find((i) => getLineItemKey(i) === lineKey);
        if (existing) {
          const nextQty = existing.quantity + qtyToAdd;
          return prev.map((i) =>
            getLineItemKey(i) === lineKey
              ? { ...i, quantity: nextQty, lineTotal: Number((i.unitPrice * nextQty).toFixed(2)) }
              : i
          );
        }
        return [
          ...prev,
          buildCleanSaleItem({
            productId: product.id,
            name: displayName,
            variantId: variant?.id,
            variantName: variant?.name,
            note: cleanNote,
            quantity: qtyToAdd,
            unitPrice,
            costPrice,
            sku: product.sku,
            barcode: isRetail ? product.barcode : '',
          }),
        ];
      });
      return;
    }

    if (tracked && product.stock <= 0) {
      setCheckoutError(`${product.name} is out of stock.`);
      return;
    }

    const currentCartTotalForProduct = cart
      .filter((c) => c.product.id === product.id)
      .reduce((acc, c) => acc + c.quantity, 0);
    if (tracked && currentCartTotalForProduct + qtyToAdd > product.stock) {
      setCheckoutError(`Only ${product.stock} ${product.unit} available for ${product.name}.`);
      return;
    }

    setCheckoutError(null);
    setCart((prev) => {
      const existing = prev.find((c) => c.lineKey === lineKey);
      if (existing) {
        return prev.map((c) =>
          c.lineKey === lineKey ? { ...c, quantity: c.quantity + qtyToAdd } : c
        );
      }
      return [
        ...prev,
        {
          lineKey,
          product,
          variant,
          note: cleanNote || undefined,
          quantity: qtyToAdd,
        },
      ];
    });
  };

  const openVariantPicker = (product: Product) => {
    const firstVar = product.variants && product.variants.length > 0 ? product.variants[0] : null;
    setPickerProduct(product);
    setPickerVariantId(firstVar ? firstVar.id : '');
    setPickerNote('');
    setPickerQty(1);
    setCheckoutError(null);
  };

  const handleConfirmVariantPicker = () => {
    if (!pickerProduct) return;
    const selectedVar =
      pickerProduct.variants?.find((v) => v.id === pickerVariantId) ??
      pickerProduct.variants?.[0];
    addConfiguredItem(pickerProduct, selectedVar, pickerNote, pickerQty);
    setPickerProduct(null);
    setPickerVariantId('');
    setPickerNote('');
    setPickerQty(1);
  };

  const addToCart = (product: Product) => {
    if (!isRetail && Array.isArray(product.variants) && product.variants.length > 0) {
      openVariantPicker(product);
      return;
    }
    addConfiguredItem(product, undefined, undefined, 1);
  };

  const updateCartQty = (lineKey: string, delta: number) => {
    setCheckoutError(null);
    const target = cart.find((c) => c.lineKey === lineKey);
    if (!target) return;

    if (delta > 0 && isProductStockTracked(target.product)) {
      const totalForProduct = cart
        .filter((c) => c.product.id === target.product.id)
        .reduce((acc, c) => acc + c.quantity, 0);
      if (totalForProduct + delta > target.product.stock) {
        setCheckoutError(
          `Stock limit reached (${target.product.stock} ${target.product.unit}) for ${target.product.name}.`
        );
        return;
      }
    }

    setCart((prev) =>
      prev
        .map((item) => {
          if (item.lineKey !== lineKey) return item;
          return { ...item, quantity: item.quantity + delta };
        })
        .filter((item) => item.quantity > 0)
    );
  };

  const removeFromCart = (lineKey: string) => {
    setCart((prev) => prev.filter((item) => item.lineKey !== lineKey));
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
      setEditTableItems((prev) => {
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
          barcode: target.barcode,
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

  const clearCart = (keepTable = false) => {
    setCart([]);
    setTaxRateInput(String(store.taxRate ?? 0));
    setServiceChargeRateInput(
      !isRetail && orderType === 'dine_in' ? String(store.serviceChargeRate ?? 0) : '0'
    );
    setDeliveryFeeInput(
      !isRetail && orderType === 'delivery' ? String(store.defaultDeliveryFee ?? 0) : '0'
    );
    setDiscountInput('0');
    setPaymentMethod('cash');
    setAmountTenderedInput('');
    setSplitCashInput('');
    setSplitCardInput('');
    setSplitBankQrInput('');
    setDraftTokenNumber(null);
    setDraftKotSent(false);
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
          barcode: isRetail ? c.product.barcode : '',
        });
      }),
    [cart, isRetail]
  );

  // Compute live diff when editing an occupied table order (keyed by lineKey so sizes/notes are tracked)
  const tableOrderDiff = useMemo(() => {
    if (!editingTableOrder || !activeTableSession) return [];
    const origMap = new Map<string, SaleItem>();
    activeTableSession.items.forEach((i) => {
      const k = getLineItemKey(i);
      const prev = origMap.get(k);
      origMap.set(k, prev ? { ...prev, quantity: prev.quantity + i.quantity } : i);
    });
    const draftMap = new Map<string, SaleItem>();
    editTableItems.forEach((i) => {
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
      origQty: number;
      draftQty: number;
    }> = [];

    allKeys.forEach((key) => {
      const orig = origMap.get(key);
      const draft = draftMap.get(key);
      const origQty = orig?.quantity ?? 0;
      const draftQty = draft?.quantity ?? 0;
      const delta = draftQty - origQty;
      if (delta !== 0) {
        const baseName = draft?.name || orig?.name || 'Item';
        const noteSuffix = draft?.note || orig?.note ? ` [${draft?.note || orig?.note}]` : '';
        diffs.push({
          lineKey: key,
          productId: draft?.productId || orig?.productId || '',
          name: `${baseName}${noteSuffix}`,
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

  const todayDateKey = getTodayDateKey();

  const nextDailyToken = useMemo(() => {
    if (isRetail) return 1;
    let maxToken = 0;
    for (const s of sales) {
      if (s.dateKey === todayDateKey && typeof s.tokenNumber === 'number' && s.tokenNumber > maxToken) {
        maxToken = s.tokenNumber;
      }
    }
    for (const k of kotTickets) {
      const created = k.createdAt?.toDate?.();
      if (created) {
        const kDateKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(
          2,
          '0'
        )}-${String(created.getDate()).padStart(2, '0')}`;
        if (kDateKey === todayDateKey && typeof k.tokenNumber === 'number' && k.tokenNumber > maxToken) {
          maxToken = k.tokenNumber;
        }
      }
    }
    return Math.min(BLUEPRINT_LIMITS.TOKEN_NUMBER_MAX, maxToken + 1);
  }, [isRetail, sales, kotTickets, todayDateKey]);

  const activeTableToken = useMemo(() => {
    if (!activeTableSession) return undefined;
    const match = kotTickets.find((t) => {
      if (t.tableNumber !== activeTableSession.tableNumber || typeof t.tokenNumber !== 'number') {
        return false;
      }
      const created = t.createdAt?.toDate?.();
      if (!created) return true;
      const kDateKey = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(
        2,
        '0'
      )}-${String(created.getDate()).padStart(2, '0')}`;
      return kDateKey === todayDateKey;
    });
    return match?.tokenNumber;
  }, [activeTableSession, kotTickets, todayDateKey]);

  const activeOrderToken = !isRetail
    ? draftTokenNumber ?? activeTableToken ?? nextDailyToken
    : undefined;

  const effectiveServiceChargeRate = useMemo(() => {
    if (isRetail || orderType !== 'dine_in' || !serviceChargeRateInput.trim()) return 0;
    const val = Number(serviceChargeRateInput);
    if (!Number.isFinite(val) || val < 0) return 0;
    return Math.min(BLUEPRINT_LIMITS.SERVICE_CHARGE_MAX, Number(val.toFixed(2)));
  }, [isRetail, orderType, serviceChargeRateInput]);

  const effectiveDeliveryFee = useMemo(() => {
    if (isRetail || orderType !== 'delivery' || !deliveryFeeInput.trim()) return 0;
    const val = Number(deliveryFeeInput);
    if (!Number.isFinite(val) || val < 0) return 0;
    return Math.min(BLUEPRINT_LIMITS.DELIVERY_FEE_MAX, Number(val.toFixed(2)));
  }, [isRetail, orderType, deliveryFeeInput]);

  const taxableBase = Math.max(0, subtotal - discount);
  const serviceChargeAmount = useMemo(
    () => Number(((taxableBase * effectiveServiceChargeRate) / 100).toFixed(2)),
    [taxableBase, effectiveServiceChargeRate]
  );
  const taxAmount = useMemo(
    () => Number(((taxableBase * effectiveTaxRate) / 100).toFixed(2)),
    [taxableBase, effectiveTaxRate]
  );
  const grandTotal = useMemo(
    () => Number((taxableBase + serviceChargeAmount + effectiveDeliveryFee + taxAmount).toFixed(2)),
    [taxableBase, serviceChargeAmount, effectiveDeliveryFee, taxAmount]
  );
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

  const splitMetrics = useMemo(
    () =>
      computeSplitPaymentSettlement({
        grandTotal,
        cashHandedInput: splitCashInput,
        cardInput: splitCardInput,
        bankQrInput: splitBankQrInput,
      }),
    [grandTotal, splitCashInput, splitCardInput, splitBankQrInput]
  );

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
   * Print Customer Bill (Unpaid / Proforma) before collecting payment — keeps table occupied & does not create a sale
   */
  const handlePrintProformaBill = () => {
    if (combinedItems.length === 0) return;
    const cleanTable = !isRetail && orderType === 'dine_in' ? tableNumber.trim() : '';
    const refNumber = cleanTable
      ? `BILL-T${cleanTable}-${String(Date.now()).slice(-4)}`
      : `BILL-${String(Date.now()).slice(-4)}`;

    const proformaSale: Sale = {
      id: generateSafeId('bill'),
      ownerId: store.ownerId,
      storeId: store.id,
      invoiceNumber: refNumber,
      dateKey: getTodayDateKey(),
      items: combinedItems,
      itemCount: totalItemsCount,
      subtotal: Number(subtotal.toFixed(2)),
      discount: Number(discount.toFixed(2)),
      serviceChargeRate: effectiveServiceChargeRate,
      serviceChargeAmount,
      deliveryFee: effectiveDeliveryFee,
      taxRate: effectiveTaxRate,
      taxAmount,
      total: grandTotal,
      totalCost: Number(totalCost.toFixed(2)),
      profit: Number((grandTotal - taxAmount - totalCost).toFixed(2)),
      ...(activeOrderToken ? { tokenNumber: activeOrderToken } : {}),
      paymentMethod: 'cash',
      amountTendered: 0,
      changeDue: 0,
      orderType: isRetail ? 'retail' : orderType,
      tableNumber: cleanTable,
      customerName: customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX),
      customerPhone: customerPhone.trim().slice(0, BLUEPRINT_LIMITS.PHONE_MAX),
      customerAddress: customerAddress.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_ADDRESS_MAX),
      employeeId: resolvedEmployeeId || activeTableSession?.employeeId || '',
      employeeName: resolvedEmployeeName || activeTableSession?.employeeName || '',
      status: 'completed',
      createdAt: activeTableSession?.updatedAt ?? activeTableSession?.createdAt ?? null,
      updatedAt: null,
    };

    onPrintJob({ type: 'receipt', sale: proformaSale, isProforma: true });
  };

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

      // Deduct stock ONLY for newly added cart items that track stock (grouped by productId)
      const trackedQtyByProduct = new Map<string, { product: Product; quantity: number }>();
      for (const c of cart) {
        if (!isProductStockTracked(c.product)) continue;
        const prev = trackedQtyByProduct.get(c.product.id);
        trackedQtyByProduct.set(c.product.id, {
          product: c.product,
          quantity: (prev?.quantity ?? 0) + c.quantity,
        });
      }

      trackedQtyByProduct.forEach(({ product: prod, quantity }) => {
        const nextStock = Math.max(0, Number((prod.stock - quantity).toFixed(2)));
        batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });
        const logId = generateSafeId('log');
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: prod.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -quantity,
          previousStock: prod.stock,
          newStock: nextStock,
          reason: 'sale',
          note: `${isAddOn ? 'Add-on' : 'Booked'} Table ${tableNumber}${
            finalEmpName ? ` by ${finalEmpName}` : ''
          }`.slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      });

      const kotId = generateSafeId('kot');
      const ticketNumber = `KOT-T${tableNumber}-${String(Date.now()).slice(-4)}`;
      const kotItemCount = cartSaleItems.reduce((a, i) => a + i.quantity, 0);
      const tokenForTable = activeTableToken ?? nextDailyToken;

      batch.set(doc(db, 'stores', store.id, 'kotQueue', kotId), {
        ownerId,
        storeId: store.id,
        ticketNumber,
        tokenNumber: tokenForTable,
        tableNumber,
        orderType: 'dine_in',
        ticketKind: isAddOn ? 'addon' : 'new',
        items: cartSaleItems,
        itemCount: kotItemCount,
        customerName: cleanGuest,
        employeeId: finalEmpId,
        employeeName: finalEmpName,
        source: 'counter',
        status: 'printed',
        kitchenStatus: 'preparing',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await batch.commit();

      const kotSalePreview: Sale = {
        id: kotId,
        ownerId,
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
        tokenNumber: tokenForTable,
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
          : `Table ${tableNumber} is now Occupied — KOT (${formatDailyToken(tokenForTable)}) generated.`
      );
      onPrintJob({ type: 'kot', sale: kotSalePreview, isAddOn, kotId });
    } catch (err) {
      setCheckoutError(
        formatFirestoreActionError(
          err,
          isAddOn ? 'Unable to update table order.' : 'Unable to book table.'
        )
      );
      try {
        handleFirestoreError(err, isAddOn ? OperationType.UPDATE : OperationType.CREATE, tablePath);
      } catch {
        // Logged & surfaced in checkoutError
      }
    } finally {
      setProcessing(false);
    }
  };

  /**
   * Send a Takeaway or Delivery Kitchen KOT before collecting final payment (reserves today's Token #)
   */
  const handleSendTakeawayDeliveryKot = async () => {
    if (isRetail || (orderType !== 'takeaway' && orderType !== 'delivery')) return;
    if (cartSaleItems.length === 0) {
      setCheckoutError('Add at least one dish to send a Kitchen KOT.');
      return;
    }
    if (cartSaleItems.length > BLUEPRINT_LIMITS.SALE_ITEMS_MAX) {
      setCheckoutError(`Maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct items per KOT.`);
      return;
    }

    setProcessing(true);
    setCheckoutError(null);

    const tokenToUse = draftTokenNumber ?? nextDailyToken;
    const kotId = generateSafeId('kot');
    const prefix = orderType === 'delivery' ? 'DLV' : 'TKW';
    const ticketNumber = `KOT-${prefix}-${String(tokenToUse).padStart(2, '0')}-${String(
      Date.now()
    ).slice(-3)}`;
    const kotItemCount = cartSaleItems.reduce((a, i) => a + i.quantity, 0);
    const cleanGuest =
      customerName.trim().slice(0, BLUEPRINT_LIMITS.CUSTOMER_NAME_MAX) ||
      (orderType === 'delivery' ? 'Delivery Guest' : 'Takeaway Guest');
    const finalEmpId = resolvedEmployeeId.slice(0, 128);
    const finalEmpName = resolvedEmployeeName.slice(0, BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX);
    const kotPath = `stores/${store.id}/kotQueue/${kotId}`;

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'stores', store.id, 'kotQueue', kotId), {
        ownerId,
        storeId: store.id,
        ticketNumber,
        tokenNumber: tokenToUse,
        tableNumber: '',
        orderType,
        ticketKind: draftKotSent ? 'addon' : 'new',
        items: cartSaleItems,
        itemCount: kotItemCount,
        customerName: cleanGuest,
        employeeId: finalEmpId,
        employeeName: finalEmpName,
        source: 'counter',
        status: 'printed',
        kitchenStatus: 'preparing',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await batch.commit();

      const kotPreview: Sale = {
        id: kotId,
        ownerId,
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
        tokenNumber: tokenToUse,
        paymentMethod: 'cash',
        amountTendered: 0,
        changeDue: 0,
        orderType,
        tableNumber: '',
        customerName: cleanGuest,
        employeeId: finalEmpId,
        employeeName: finalEmpName,
        status: 'completed',
        createdAt: null,
        updatedAt: null,
      };

      setDraftTokenNumber(tokenToUse);
      setDraftKotSent(true);
      showTempNotice(
        `Kitchen KOT sent for ${
          orderType === 'delivery' ? 'Delivery' : 'Takeaway'
        } (${formatDailyToken(tokenToUse)})!`
      );
      onPrintJob({ type: 'kot', sale: kotPreview, isAddOn: draftKotSent, kotId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to send Kitchen KOT.';
      setCheckoutError(`KOT failed: ${msg}`);
      try {
        handleFirestoreError(err, OperationType.CREATE, kotPath);
      } catch {
        // Logged & shown
      }
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

    // Aggregate net stock delta per productId so variant/note lines sum cleanly
    const stockDeltaByProduct = new Map<string, number>();
    tableOrderDiff.forEach((d) => {
      stockDeltaByProduct.set(d.productId, (stockDeltaByProduct.get(d.productId) ?? 0) + d.delta);
    });

    // Verify sufficient stock for any increased/newly added stock-tracked items
    for (const [pid, netDelta] of stockDeltaByProduct.entries()) {
      if (netDelta > 0) {
        const prod = products.find((p) => p.id === pid);
        if (prod && isProductStockTracked(prod) && prod.stock < netDelta) {
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

      // Reconcile inventory stock for every changed stock-tracked item (grouped by productId)
      let stockLogIdx = 0;
      stockDeltaByProduct.forEach((netDelta, pid) => {
        if (netDelta === 0) return;
        const prod = products.find((p) => p.id === pid);
        if (!prod || !isProductStockTracked(prod)) return;
        const currentStock = Number.isFinite(Number(prod.stock)) ? Number(prod.stock) : 0;
        const nextStock = Math.max(
          0,
          Math.min(10000000, Number((currentStock - netDelta).toFixed(2)))
        );
        batch.update(doc(db, 'stores', store.id, 'products', prod.id), {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = `${generateSafeId('log')}_${stockLogIdx++}`;
        batch.set(doc(db, 'stores', store.id, 'stockLogs', logId), {
          ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: String(prod.name || 'Item').slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: Number((-netDelta).toFixed(2)),
          previousStock: currentStock,
          newStock: nextStock,
          reason: netDelta > 0 ? 'sale' : 'adjustment',
          note: (isCancellingTable
            ? `Cancelled Table ${tableNum}${finalEmpName ? ` by ${finalEmpName}` : ''}`
            : netDelta > 0
            ? `Table ${tableNum} edit (+${netDelta})${finalEmpName ? ` by ${finalEmpName}` : ''}`
            : `Table ${tableNum} edit (${netDelta})${finalEmpName ? ` by ${finalEmpName}` : ''}`
          ).slice(0, BLUEPRINT_LIMITS.STOCK_NOTE_MAX),
          createdAt: serverTimestamp(),
        });
      });

      const sanitizedItems: SaleItem[] = editTableItems.map((item) =>
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
          barcode: isRetail ? String(item.barcode ?? '').slice(0, BLUEPRINT_LIMITS.BARCODE_MAX) : '',
        })
      );

      const revKotId = printRevisedKot && !isCancellingTable ? generateSafeId('kot') : '';
      const revTicketNumber = `KOT-REV-T${tableNum}-${String(Date.now()).slice(-4)}`;
      const sanitizedCount = sanitizedItems.reduce((acc, i) => acc + i.quantity, 0);

      if (isCancellingTable) {
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
        const nextSubtotal = Number(
          sanitizedItems.reduce((acc, i) => acc + i.lineTotal, 0).toFixed(2)
        );
        const nextCost = Number(
          sanitizedItems.reduce((acc, i) => acc + i.costPrice * i.quantity, 0).toFixed(2)
        );

        batch.update(tableRef, {
          items: sanitizedItems,
          itemCount: sanitizedCount,
          subtotal: nextSubtotal,
          totalCost: nextCost,
          customerName: cleanGuest,
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          updatedAt: serverTimestamp(),
        });

        if (revKotId) {
          batch.set(doc(db, 'stores', store.id, 'kotQueue', revKotId), {
            ownerId,
            storeId: store.id,
            ticketNumber: revTicketNumber,
            tableNumber: tableNum,
            orderType: 'dine_in',
            ticketKind: 'revised',
            items: sanitizedItems,
            itemCount: sanitizedCount,
            changeNotes: changeNotes.slice(0, 50),
            customerName: cleanGuest,
            employeeId: finalEmpId,
            employeeName: finalEmpName,
            source: 'counter',
            status: 'printed',
            kitchenStatus: 'preparing',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      await batch.commit();

      const revisedKotPreview: Sale | null =
        printRevisedKot && !isCancellingTable
          ? {
              id: revKotId || `kot_rev_${Date.now()}`,
              ownerId,
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
          kotId: revKotId || undefined,
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

  const openTransferModal = () => {
    if (isRetail || orderType !== 'dine_in' || !activeTableSession || editingTableOrder) return;
    if (cart.length > 0) {
      setCheckoutError(
        'Please send/book or clear your unsaved add-on items before shifting or merging this table.'
      );
      return;
    }
    const candidates = tableNumbersList.filter((n) => n !== activeTableSession.tableNumber);
    if (candidates.length === 0) {
      setCheckoutError('No other tables configured to transfer or merge into.');
      return;
    }
    const firstEmpty = candidates.find((n) => !tableSessionMap.has(n));
    setTransferTargetTable(firstEmpty ?? candidates[0]);
    setTransferNotifyKot(false);
    setTransferError(null);
    setTransferModalOpen(true);
  };

  const handleConfirmTableTransferOrMerge = async () => {
    if (!activeTableSession || !transferTargetTable) return;
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
        `Merged bill exceeds maximum ${BLUEPRINT_LIMITS.SALE_ITEMS_MAX} distinct line items.`
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

    const finalEmpId = (targetSession?.employeeId || sourceSession.employeeId || '').slice(0, 128);
    const finalEmpName = (targetSession?.employeeName || sourceSession.employeeName || '').slice(
      0,
      BLUEPRINT_LIMITS.EMPLOYEE_NAME_MAX
    );

    const targetTableId = `table_${targetTable.replace(/[^a-zA-Z0-9_\-]/g, '')}`;
    const targetPath = `stores/${store.id}/tables/${targetTableId}`;

    setProcessing(true);
    setTransferError(null);
    setCheckoutError(null);

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
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(targetRef, {
          ownerId,
          storeId: store.id,
          tableNumber: targetTable,
          status: 'occupied',
          items: finalItems,
          itemCount: finalCount,
          subtotal: finalSubtotal,
          totalCost: finalCost,
          customerName: combinedCustomerName,
          employeeId: finalEmpId,
          employeeName: finalEmpName,
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

      const shiftChangeNotes = [
        isMerge
          ? `MERGED: Table ${sourceSession.tableNumber} + Table ${targetTable} → Table ${targetTable}`
          : `SHIFTED: Table ${sourceSession.tableNumber} → Table ${targetTable}`,
      ];
      const shiftKotId = transferNotifyKot ? generateSafeId('kot') : '';
      const shiftTicketNumber = `${isMerge ? 'KOT-MRG' : 'KOT-SHF'}-T${targetTable}-${String(
        Date.now()
      ).slice(-4)}`;

      if (shiftKotId) {
        batch.set(doc(db, 'stores', store.id, 'kotQueue', shiftKotId), {
          ownerId,
          storeId: store.id,
          ticketNumber: shiftTicketNumber,
          tableNumber: targetTable,
          orderType: 'dine_in',
          ticketKind: 'revised',
          items: finalItems,
          itemCount: finalCount,
          changeNotes: shiftChangeNotes,
          customerName: combinedCustomerName,
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          source: 'counter',
          status: 'printed',
          kitchenStatus: 'preparing',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      setTransferModalOpen(false);
      setTableNumber(targetTable);
      setCustomerName(combinedCustomerName);
      setSelectedEmployeeId(finalEmpId);

      showTempNotice(
        isMerge
          ? `Table ${sourceSession.tableNumber} merged into Table ${targetTable}!`
          : `Table ${sourceSession.tableNumber} shifted to Table ${targetTable}!`
      );

      if (transferNotifyKot) {
        const kotSalePreview: Sale = {
          id: shiftKotId || `kot_shift_${Date.now()}`,
          ownerId,
          storeId: store.id,
          invoiceNumber: shiftTicketNumber,
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
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          status: 'completed',
          createdAt: null,
          updatedAt: null,
        };
        onPrintJob({
          type: 'kot',
          sale: kotSalePreview,
          isRevised: true,
          changeNotes: shiftChangeNotes,
          kotId: shiftKotId || undefined,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to complete table transfer.';
      setTransferError(`Could not ${isMerge ? 'merge' : 'transfer'} table: ${msg}`);
      try {
        handleFirestoreError(err, isMerge ? OperationType.UPDATE : OperationType.CREATE, targetPath);
      } catch {
        // Logged & surfaced in transferError
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

    if (paymentMethod === 'split') {
      if (splitMetrics.nonCashExceedsTotal) {
        setCheckoutError('Card + Bank/QR total cannot exceed the grand total.');
        return;
      }
      if (splitMetrics.remainingToPay > 0) {
        setCheckoutError(
          `Split payments total is short by ${formatMoney(
            splitMetrics.remainingToPay,
            store.currency
          )}.`
        );
        return;
      }
      if (grandTotal > 0 && splitMetrics.activeMethodsCount < 2) {
        setCheckoutError(
          'Enter amounts for at least 2 payment methods (e.g. Cash + Card) for Split Payment.'
        );
        return;
      }
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
    const assignedToken = !isRetail ? (draftTokenNumber ?? activeTableToken ?? nextDailyToken) : undefined;
    const shouldCreateTakeawayDeliveryKot =
      !isRetail &&
      (effectiveOrderType === 'takeaway' || effectiveOrderType === 'delivery') &&
      sendKotOnTakeawayDelivery &&
      !draftKotSent;
    const finalAmountTendered =
      paymentMethod === 'split' ? splitMetrics.tenderedTotal : Number(parsedTendered.toFixed(2));
    const finalChangeDue = paymentMethod === 'split' ? splitMetrics.changeDue : changeDue;

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
        ...(effectiveServiceChargeRate > 0 || serviceChargeAmount > 0
          ? {
              serviceChargeRate: effectiveServiceChargeRate,
              serviceChargeAmount,
            }
          : {}),
        ...(effectiveDeliveryFee > 0 ? { deliveryFee: effectiveDeliveryFee } : {}),
        taxRate: effectiveTaxRate,
        taxAmount,
        total: grandTotal,
        totalCost: Number(totalCost.toFixed(2)),
        profit: netProfit,
        ...(assignedToken ? { tokenNumber: assignedToken } : {}),
        paymentMethod,
        ...(paymentMethod === 'split' ? { paymentSplit: splitMetrics.paymentSplit } : {}),
        amountTendered: finalAmountTendered,
        changeDue: finalChangeDue,
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

      if (shouldCreateTakeawayDeliveryKot) {
        const kotId = generateSafeId('kot');
        const prefix = effectiveOrderType === 'delivery' ? 'DLV' : 'TKW';
        const ticketNumber = `KOT-${prefix}-${String(assignedToken ?? nextDailyToken).padStart(
          2,
          '0'
        )}-${String(Date.now()).slice(-3)}`;
        batch.set(doc(db, 'stores', store.id, 'kotQueue', kotId), {
          ownerId,
          storeId: store.id,
          ticketNumber,
          ...(assignedToken ? { tokenNumber: assignedToken } : {}),
          tableNumber: '',
          orderType: effectiveOrderType,
          ticketKind: 'new',
          items: combinedItems,
          itemCount: totalItemsCount,
          customerName: cleanName,
          employeeId: finalEmpId,
          employeeName: finalEmpName,
          source: 'counter',
          status: 'printed',
          kitchenStatus: 'preparing',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      // Deduct stock ONLY for items currently in the unsaved cart that track stock (grouped by productId)
      const trackedCartByProduct = new Map<string, { product: Product; quantity: number }>();
      for (const c of cart) {
        if (!isProductStockTracked(c.product)) continue;
        const prev = trackedCartByProduct.get(c.product.id);
        trackedCartByProduct.set(c.product.id, {
          product: c.product,
          quantity: (prev?.quantity ?? 0) + c.quantity,
        });
      }

      trackedCartByProduct.forEach(({ product: prod, quantity }) => {
        const nextStock = Math.max(0, Number((prod.stock - quantity).toFixed(2)));
        const prodRef = doc(db, 'stores', store.id, 'products', prod.id);
        batch.update(prodRef, {
          stock: nextStock,
          updatedAt: serverTimestamp(),
        });

        const logId = generateSafeId('log');
        const logRef = doc(db, 'stores', store.id, 'stockLogs', logId);
        batch.set(logRef, {
          ownerId,
          storeId: store.id,
          productId: prod.id,
          productName: prod.name.slice(0, BLUEPRINT_LIMITS.PRODUCT_NAME_MAX),
          change: -quantity,
          previousStock: prod.stock,
          newStock: nextStock,
          reason: 'sale',
          note: `Invoice ${invoiceNumber}${finalEmpName ? ` by ${finalEmpName}` : ''}`.slice(
            0,
            BLUEPRINT_LIMITS.STOCK_NOTE_MAX
          ),
          createdAt: serverTimestamp(),
        });
      });

      // If settling an occupied dine-in table, clear the table in the atomic settlement batch
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

      // Mark any active kitchen KOTs for the settled table as served (non-blocking so missing/stale KOTs never block billing)
      let kotSyncWarning: string | null = null;
      if (activeTableSession) {
        const tableKotsToServe = kotTickets.filter(
          (t) =>
            t.tableNumber === activeTableSession.tableNumber &&
            t.ticketKind !== 'reprint' &&
            t.kitchenStatus !== 'served'
        );
        if (tableKotsToServe.length > 0) {
          try {
            const kotBatch = writeBatch(db);
            tableKotsToServe.forEach((t) => {
              kotBatch.update(doc(db, 'stores', store.id, 'kotQueue', t.id), {
                kitchenStatus: 'served',
                updatedAt: serverTimestamp(),
              });
            });
            await kotBatch.commit();
          } catch (kotErr) {
            const rawKotMsg = kotErr instanceof Error ? kotErr.message : String(kotErr ?? '');
            if (rawKotMsg.toLowerCase().includes('permission')) {
              kotSyncWarning =
                'Table settled, but KOT status could not be marked Served — please publish the latest firestore.rules in Firebase Console.';
            }
          }
        }
      }

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
        serviceChargeRate: effectiveServiceChargeRate,
        serviceChargeAmount,
        deliveryFee: effectiveDeliveryFee,
        taxRate: effectiveTaxRate,
        taxAmount,
        total: grandTotal,
        totalCost: Number(totalCost.toFixed(2)),
        profit: netProfit,
        ...(assignedToken ? { tokenNumber: assignedToken } : {}),
        paymentMethod,
        ...(paymentMethod === 'split' ? { paymentSplit: splitMetrics.paymentSplit } : {}),
        amountTendered: finalAmountTendered,
        changeDue: finalChangeDue,
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
      if (kotSyncWarning) {
        setCheckoutError(kotSyncWarning);
      }
      setMobileCartOpen(false);
      if (autoPrint) {
        onPrintJob({ type: 'receipt', sale: completedSale });
      } else {
        showTempNotice(
          activeTableSession
            ? `Table ${activeTableSession.tableNumber} settled and cleared to Empty.`
            : `Bill ${invoiceNumber}${assignedToken ? ` (Token ${formatDailyToken(assignedToken)})` : ''} saved.`
        );
      }
    } catch (err) {
      setCheckoutError(
        formatFirestoreActionError(
          err,
          activeTableSession ? 'Unable to settle table bill.' : 'Unable to complete bill.'
        )
      );
      try {
        handleFirestoreError(err, OperationType.WRITE, salePath);
      } catch {
        // Logged & surfaced in checkoutError
      }
    } finally {
      setProcessing(false);
    }
  };

  const renderCartPanel = () => (
    <div className="flex flex-col h-full max-h-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {activeTableSession ? `Table ${activeTableSession.tableNumber} · Occupied` : 'Current Bill'}
            </h2>
            {!isRetail && activeOrderToken && (
              <span className="rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-[10px] font-bold font-mono px-1.5 py-0.5">
                Token {formatDailyToken(activeOrderToken)}
              </span>
            )}
            {!isRetail && draftKotSent && (
              <span className="rounded bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300 text-[10px] font-semibold px-1.5 py-0.5">
                KOT Sent
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {totalItemsCount} {totalItemsCount === 1 ? 'item' : 'items'}
            {activeTableSession && cart.length > 0 ? ` (${cart.length} new add-on)` : ''}
            {activeTableSession?.employeeName ? ` · ${activeTableSession.employeeName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
          {activeTableSession && !editingTableOrder && (
            <>
              <button
                type="button"
                onClick={openTransferModal}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                title="Transfer to another table or merge with another occupied table"
              >
                <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" />
                <span>Shift / Merge</span>
              </button>
              <button
                type="button"
                onClick={handlePrintProformaBill}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 whitespace-nowrap cursor-pointer"
                title="Print unpaid customer bill without clearing the table"
              >
                <Receipt className="w-3.5 h-3.5 shrink-0" />
                <span>Print Bill</span>
              </button>
              <button
                type="button"
                onClick={startEditingTableOrder}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/70 dark:border-amber-600 bg-amber-50 dark:bg-amber-950/50 px-2.5 py-1.5 text-xs font-semibold text-amber-900 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/80 whitespace-nowrap cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5 shrink-0" />
                <span>Edit Order</span>
              </button>
            </>
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
                {editTableItems.map((item) => {
                  const lineKey = getLineItemKey(item);
                  return (
                    <div key={lineKey} className="py-2.5 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {item.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          {formatMoney(item.unitPrice, store.currency)} × {item.quantity}
                        </div>
                        {item.note && (
                          <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mt-0.5 truncate">
                            Note: {item.note}
                          </div>
                        )}
                        {!isRetail && (
                          <button
                            type="button"
                            onClick={() => {
                              setNoteTarget({
                                mode: 'edit_table',
                                lineKey,
                                title: item.name,
                              });
                              setNoteDraft(item.note || '');
                            }}
                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium brand-text hover:underline cursor-pointer"
                          >
                            <StickyNote className="w-3 h-3" />
                            <span>{item.note ? 'Edit Note' : '+ Kitchen Note'}</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateEditTableItemQty(lineKey, -1)}
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
                          onClick={() => updateEditTableItemQty(lineKey, 1)}
                          className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          aria-label={`Increase ${item.name}`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeEditTableItem(lineKey)}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                          aria-label={`Remove ${item.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
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
                {activeTableKots.length > 0 && (
                  <div className="space-y-1.5">
                    {activeTableKots.map((kt) => {
                      const isReady = kt.kitchenStatus === 'ready';
                      return (
                        <div
                          key={kt.id}
                          className={`rounded-lg border px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] ${
                            isReady
                              ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-950 dark:text-emerald-100'
                              : 'border-orange-200 dark:border-orange-900/60 bg-orange-50/70 dark:bg-orange-950/25 text-orange-950 dark:text-orange-200'
                          }`}
                        >
                          <span className="inline-flex items-center gap-1.5 font-semibold truncate">
                            {isReady ? (
                              <Bell className="w-3 h-3 text-emerald-600 shrink-0" />
                            ) : (
                              <ChefHat className="w-3 h-3 text-orange-600 shrink-0" />
                            )}
                            <span>{isReady ? 'Kitchen: Ready' : 'Kitchen: Preparing'}</span>
                          </span>
                          {onUpdateKitchenStatus && (
                            <button
                              type="button"
                              disabled={busyKotId === kt.id}
                              onClick={() =>
                                void handleUpdateTableKotStatus(kt.id, isReady ? 'served' : 'ready')
                              }
                              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-semibold text-white shrink-0 disabled:opacity-50 cursor-pointer ${
                                isReady
                                  ? 'bg-slate-900 dark:bg-slate-100 dark:text-slate-900'
                                  : 'bg-emerald-600 hover:bg-emerald-700'
                              }`}
                            >
                              <CheckCheck className="w-3 h-3" />
                              <span>
                                {busyKotId === kt.id
                                  ? 'Updating...'
                                  : isReady
                                  ? 'Served'
                                  : 'Mark Ready'}
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

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
                  {activeTableSession.items.map((item, idx) => {
                    const lineKey = getLineItemKey(item);
                    return (
                      <div
                        key={`${lineKey}-${idx}`}
                        className="py-2 flex items-center justify-between gap-2 text-xs text-slate-700 dark:text-slate-200"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{item.name}</div>
                          <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                            {formatMoney(item.unitPrice, store.currency)} × {item.quantity} ={' '}
                            {formatMoney(item.lineTotal, store.currency)}
                          </div>
                          {item.note && (
                            <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300 truncate">
                              Note: {item.note}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => startEditingAndAdjustItem(lineKey, 0, false, true)}
                            className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                            aria-label={`Edit note for ${item.name}`}
                            title="Add / edit kitchen note"
                          >
                            <StickyNote className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditingAndAdjustItem(lineKey, -1)}
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
                            onClick={() => startEditingAndAdjustItem(lineKey, 1)}
                            className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                            aria-label={`Increase ${item.name} on table`}
                            title="Increase quantity"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditingAndAdjustItem(lineKey, 0, true)}
                            className="w-7 h-7 rounded-md flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                            aria-label={`Remove ${item.name} from table`}
                            title="Remove item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
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
                {cart.map((c) => {
                  const unitPrice = c.variant ? c.variant.price : c.product.sellingPrice;
                  const displayName = formatDishNameWithVariant(c.product.name, c.variant?.name);
                  return (
                    <div key={c.lineKey} className="py-3 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {displayName}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          {formatMoney(unitPrice, store.currency)} × {c.quantity}
                        </div>
                        {c.note && (
                          <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mt-0.5 truncate">
                            Note: {c.note}
                          </div>
                        )}
                        {!isRetail && (
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
                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium brand-text hover:underline cursor-pointer"
                          >
                            <StickyNote className="w-3 h-3" />
                            <span>{c.note ? 'Edit Note' : '+ Kitchen Note'}</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => updateCartQty(c.lineKey, -1)}
                          className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          aria-label={`Decrease ${displayName}`}
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="w-7 text-center text-xs font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                          {c.quantity}
                        </span>
                        <button
                          type="button"
                          onClick={() => updateCartQty(c.lineKey, 1)}
                          className="w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          aria-label={`Increase ${displayName}`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromCart(c.lineKey)}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                          aria-label={`Remove ${displayName}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
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

              {/* Dine-In Service Charge (%) — pre-fills store default or allows manual override */}
              {!isRetail && orderType === 'dine_in' && (
                <div className="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <label htmlFor="pos-service-charge-input" className="whitespace-nowrap">
                      Service (%)
                    </label>
                    {effectiveServiceChargeRate !== 0 && (
                      <button
                        type="button"
                        onClick={() => setServiceChargeRateInput('0')}
                        className="text-[10px] font-medium text-slate-500 hover:text-red-600 dark:hover:text-red-400 underline cursor-pointer"
                      >
                        0%
                      </button>
                    )}
                    {(store.serviceChargeRate ?? 0) > 0 &&
                      effectiveServiceChargeRate !== (store.serviceChargeRate ?? 0) && (
                        <button
                          type="button"
                          onClick={() =>
                            setServiceChargeRateInput(String(store.serviceChargeRate ?? 0))
                          }
                          className="text-[10px] font-medium brand-text hover:underline whitespace-nowrap cursor-pointer"
                        >
                          Default ({store.serviceChargeRate}%)
                        </button>
                      )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="relative flex items-center">
                      <input
                        id="pos-service-charge-input"
                        type="number"
                        min="0"
                        max={BLUEPRINT_LIMITS.SERVICE_CHARGE_MAX}
                        step="any"
                        value={serviceChargeRateInput}
                        onChange={(e) => setServiceChargeRateInput(e.target.value)}
                        placeholder="0"
                        className="w-16 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-2 pr-5 py-1 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
                      />
                      <span className="absolute right-1.5 text-[10px] text-slate-400 pointer-events-none">
                        %
                      </span>
                    </div>
                    <span className="min-w-[68px] text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {formatMoney(serviceChargeAmount, store.currency)}
                    </span>
                  </div>
                </div>
              )}

              {/* Delivery Fee — pre-fills store default or allows manual override */}
              {!isRetail && orderType === 'delivery' && (
                <div className="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <label htmlFor="pos-delivery-fee-input" className="whitespace-nowrap">
                      Delivery Fee ({store.currency})
                    </label>
                    {effectiveDeliveryFee !== 0 && (
                      <button
                        type="button"
                        onClick={() => setDeliveryFeeInput('0')}
                        className="text-[10px] font-medium text-slate-500 hover:text-red-600 dark:hover:text-red-400 underline cursor-pointer"
                      >
                        Free
                      </button>
                    )}
                    {(store.defaultDeliveryFee ?? 0) > 0 &&
                      effectiveDeliveryFee !== (store.defaultDeliveryFee ?? 0) && (
                        <button
                          type="button"
                          onClick={() => setDeliveryFeeInput(String(store.defaultDeliveryFee ?? 0))}
                          className="text-[10px] font-medium brand-text hover:underline whitespace-nowrap cursor-pointer"
                        >
                          Default ({store.defaultDeliveryFee})
                        </button>
                      )}
                  </div>
                  <input
                    id="pos-delivery-fee-input"
                    type="number"
                    min="0"
                    max={BLUEPRINT_LIMITS.DELIVERY_FEE_MAX}
                    step="any"
                    value={deliveryFeeInput}
                    onChange={(e) => setDeliveryFeeInput(e.target.value)}
                    placeholder="0"
                    className="w-24 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
                  />
                </div>
              )}

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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {(
                [
                  { id: 'cash', label: 'Cash', icon: Banknote },
                  { id: 'card', label: 'Card', icon: CreditCard },
                  { id: 'bank_qr', label: 'Bank/QR', icon: QrCode },
                  { id: 'split', label: 'Split', icon: Wallet },
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

            {/* Split Payment Breakdown Inputs */}
            {paymentMethod === 'split' && (
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2.5 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    Split Bill ({formatMoney(grandTotal, store.currency)})
                  </span>
                  {(splitCashInput || splitCardInput || splitBankQrInput) && (
                    <button
                      type="button"
                      onClick={() => {
                        setSplitCashInput('');
                        setSplitCardInput('');
                        setSplitBankQrInput('');
                        setCheckoutError(null);
                      }}
                      className="text-[10px] text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                    >
                      Clear Split
                    </button>
                  )}
                </div>

                {(
                  [
                    {
                      id: 'split-cash-input',
                      label: 'Cash',
                      value: splitCashInput,
                      setter: setSplitCashInput,
                      otherSum: splitMetrics.cardAmount + splitMetrics.bankQrAmount,
                    },
                    {
                      id: 'split-card-input',
                      label: 'Card',
                      value: splitCardInput,
                      setter: setSplitCardInput,
                      otherSum: splitMetrics.cashHanded + splitMetrics.bankQrAmount,
                    },
                    {
                      id: 'split-qr-input',
                      label: 'Bank / QR',
                      value: splitBankQrInput,
                      setter: setSplitBankQrInput,
                      otherSum: splitMetrics.cashHanded + splitMetrics.cardAmount,
                    },
                  ] as const
                ).map((row) => {
                  const restForField = Math.max(0, Number((grandTotal - row.otherSum).toFixed(2)));
                  return (
                    <div key={row.id} className="flex items-center justify-between gap-2">
                      <label
                        htmlFor={row.id}
                        className="font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap"
                      >
                        {row.label}
                      </label>
                      <div className="flex items-center gap-1.5">
                        {restForField > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              row.setter(String(restForField));
                              setCheckoutError(null);
                            }}
                            className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-1.5 py-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:border-slate-400 cursor-pointer whitespace-nowrap"
                            title={`Fill remaining ${formatMoney(restForField, store.currency)}`}
                          >
                            Fill Rest
                          </button>
                        )}
                        <input
                          id={row.id}
                          type="number"
                          min="0"
                          step="any"
                          value={row.value}
                          onChange={(e) => {
                            row.setter(e.target.value);
                            setCheckoutError(null);
                          }}
                          placeholder="0.00"
                          className="w-24 rounded-md border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-right font-mono font-semibold tabular-nums text-xs text-slate-900 dark:text-slate-100"
                        />
                      </div>
                    </div>
                  );
                })}

                {grandTotal > 0 && (
                  splitMetrics.nonCashExceedsTotal ? (
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs font-semibold text-red-600 dark:text-red-400">
                      <span>Card + Bank/QR exceeds bill total</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(splitMetrics.nonCashTotal, store.currency)}
                      </span>
                    </div>
                  ) : splitMetrics.remainingToPay > 0 ? (
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs font-semibold text-amber-700 dark:text-amber-400">
                      <span>Remaining to Allocate</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(splitMetrics.remainingToPay, store.currency)}
                      </span>
                    </div>
                  ) : splitMetrics.changeDue > 0 ? (
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      <span>Change / Return (Cash)</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(splitMetrics.changeDue, store.currency)}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between pt-1.5 border-t border-slate-100 dark:border-slate-800 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      <span>Split Matched</span>
                      <span className="font-mono tabular-nums">
                        {formatMoney(grandTotal, store.currency)}
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

              {/* Takeaway / Delivery Kitchen KOT Option */}
              {!isRetail && (orderType === 'takeaway' || orderType === 'delivery') && cart.length > 0 && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    disabled={processing}
                    onClick={() => void handleSendTakeawayDeliveryKot()}
                    className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-600 dark:border-amber-500 bg-amber-50 dark:bg-amber-950/40 px-4 py-2.5 text-xs font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/70 disabled:opacity-45 transition-colors cursor-pointer"
                  >
                    <ChefHat className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      {draftKotSent
                        ? `Send Extra Kitchen KOT (${formatDailyToken(activeOrderToken)})`
                        : `Send Kitchen KOT (${formatDailyToken(activeOrderToken)})`}
                    </span>
                  </button>
                  {!draftKotSent && (
                    <label className="flex items-center gap-2 px-1 text-[11px] text-slate-600 dark:text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={sendKotOnTakeawayDelivery}
                        onChange={(e) => setSendKotOnTakeawayDelivery(e.target.checked)}
                        className="rounded border-slate-300 dark:border-slate-700"
                      />
                      <span>Also send to Kitchen Display / KOT on bill completion</span>
                    </label>
                  )}
                </div>
              )}

              {/* Pre-Payment Print Bill Only (Keeps Table Open / Does Not Settle Payment) */}
              {combinedItems.length > 0 && (
                <button
                  type="button"
                  disabled={processing}
                  onClick={handlePrintProformaBill}
                  className="w-full flex items-center justify-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  <Receipt className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {activeTableSession
                      ? `Print Table ${activeTableSession.tableNumber} Bill (Before Payment)`
                      : 'Print Bill Only (Before Payment)'}
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
              const kStatus = tableKitchenStatusMap.get(session.tableNumber);
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
                      : kStatus === 'ready'
                      ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'
                      : 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950/60'
                  }`}
                >
                  Table {session.tableNumber}
                  {session.employeeName ? ` (${session.employeeName})` : ''} · {session.itemCount}{' '}
                  items ·{' '}
                  <span className="font-mono tabular-nums">
                    {formatMoney(session.subtotal, store.currency)}
                  </span>
                  {kStatus && (
                    <span
                      className={`ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        kStatus === 'ready'
                          ? 'bg-emerald-600 text-white'
                          : kStatus === 'preparing'
                          ? 'bg-orange-200/80 text-orange-950 dark:bg-orange-900/70 dark:text-orange-200'
                          : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      }`}
                    >
                      {kStatus === 'ready' ? 'Ready' : kStatus === 'preparing' ? 'Cooking' : 'Served'}
                    </span>
                  )}
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
              const hasVariants =
                !isRetail && Array.isArray(product.variants) && product.variants.length > 0;
              const minVariantPrice = hasVariants
                ? Math.min(...product.variants!.map((v) => v.price))
                : product.sellingPrice;

              const inCart =
                editingTableOrder && activeTableSession
                  ? editTableItems
                      .filter((i) => i.productId === product.id)
                      .reduce((acc, i) => acc + i.quantity, 0)
                  : cart
                      .filter((c) => c.product.id === product.id)
                      .reduce((acc, c) => acc + c.quantity, 0);
              const originalOnTable = activeTableSession
                ? activeTableSession.items
                    .filter((i) => i.productId === product.id)
                    .reduce((acc, i) => acc + i.quantity, 0)
                : 0;
              const displayQty =
                editingTableOrder && activeTableSession ? inCart : inCart > 0 ? inCart : 0;
              const canQuickDecrement =
                !hasVariants &&
                (inCart > 0 || (!!activeTableSession && !editingTableOrder && originalOnTable > 0));
              const tracked = isProductStockTracked(product);
              const availableStock =
                editingTableOrder && activeTableSession
                  ? product.stock + Math.max(0, originalOnTable - inCart)
                  : product.stock;
              const isOut = tracked && availableStock <= 0;
              const isLow = tracked && product.stock > 0 && product.stock <= product.minStock;

              const handleCardDecrement = (e: React.MouseEvent) => {
                e.stopPropagation();
                if (hasVariants) return;
                if (editingTableOrder && activeTableSession) {
                  const match = [...editTableItems]
                    .reverse()
                    .find((i) => i.productId === product.id);
                  if (match) updateEditTableItemQty(getLineItemKey(match), -1);
                } else if (inCart > 0) {
                  const match = [...cart].reverse().find((c) => c.product.id === product.id);
                  if (match) updateCartQty(match.lineKey, -1);
                } else if (activeTableSession && originalOnTable > 0) {
                  const match = [...activeTableSession.items]
                    .reverse()
                    .find((i) => i.productId === product.id);
                  if (match) startEditingAndAdjustItem(getLineItemKey(match), -1);
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
                      {hasVariants ? ` · ${product.variants!.length} sizes` : ''}
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
                      <span className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 truncate">
                        {hasVariants
                          ? `From ${formatMoney(minVariantPrice, store.currency)}`
                          : formatMoney(product.sellingPrice, store.currency)}
                      </span>
                      <span
                        className={`text-[11px] font-mono tabular-nums shrink-0 ${
                          !tracked
                            ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                            : isOut
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : isLow
                            ? 'text-amber-600 dark:text-amber-400 font-medium'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {!tracked ? 'Fresh' : isOut ? 'Out' : `${product.stock} ${product.unit}`}
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
      <div className="hidden lg:block lg:col-span-4 lg:sticky lg:top-0 lg:h-[calc(100vh-6.5rem)]">
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
                  Select portion size &amp; optional kitchen instructions
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
                  Select Size / Portion *
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
                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 hover:border-slate-400'
                        }`}
                      >
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {v.name}
                        </div>
                        <div className="text-xs font-bold font-mono tabular-nums brand-text mt-0.5">
                          {formatMoney(v.price, store.currency)}
                        </div>
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
                  Add{' '}
                  {formatMoney(
                    (pickerProduct.variants?.find((v) => v.id === pickerVariantId)?.price ??
                      pickerProduct.sellingPrice) * pickerQty,
                    store.currency
                  )}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kitchen Note Editor Modal for Cart / Table Items */}
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
                  Printed on KOT &amp; visible to kitchen staff
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
                  Move to an Empty table, or pick an Occupied table to combine both bills
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
              <span className="font-mono font-bold brand-text tabular-nums">
                {formatMoney(activeTableSession.subtotal, store.currency)}
              </span>
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
                            ? `${occ.itemCount} items · ${formatMoney(occ.subtotal, store.currency)}`
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
                    <strong>Merge Preview:</strong> All items from Table{' '}
                    {activeTableSession.tableNumber} will be combined into{' '}
                    <strong>Table {transferTargetTable}</strong> (New total:{' '}
                    <strong className="font-mono">
                      {formatMoney(
                        activeTableSession.subtotal +
                          (tableSessionMap.get(transferTargetTable)?.subtotal ?? 0),
                        store.currency
                      )}
                    </strong>
                    ), and Table {activeTableSession.tableNumber} will become Empty.
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
              <span>Print Shift / Merge Notice KOT for Kitchen (optional)</span>
            </label>

            {transferError && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                {transferError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={processing}
                onClick={() => setTransferModalOpen(false)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={processing || !transferTargetTable}
                onClick={() => void handleConfirmTableTransferOrMerge()}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl brand-bg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 cursor-pointer"
              >
                <ArrowRightLeft className="w-4 h-4" />
                <span>
                  {processing
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
};
