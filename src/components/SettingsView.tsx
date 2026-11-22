import React, { useEffect, useState } from 'react';
import {
  Check,
  KeyRound,
  Monitor,
  Moon,
  Printer,
  ShieldCheck,
  Smartphone,
  Store,
  Sun,
  Trash2,
  Upload,
  UtensilsCrossed,
} from 'lucide-react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { BLUEPRINT_LIMITS, type BusinessType, type StoreConfig } from '../types';
import { compressLogoImage, CURRENCY_OPTIONS, THEME_PRESETS } from '../utils/posHelpers';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsViewProps {
  store: StoreConfig;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  userEmail?: string | null;
  hasPassword?: boolean;
  onOpenPasswordSetup?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  store,
  darkMode,
  onToggleDarkMode,
  userEmail,
  hasPassword = false,
  onOpenPasswordSetup,
}) => {
  const [name, setName] = useState(store.name);
  const [businessType, setBusinessType] = useState<BusinessType>(store.businessType);
  const [logoDataUrl, setLogoDataUrl] = useState(store.logoDataUrl);
  const [primaryColor, setPrimaryColor] = useState(store.primaryColor);
  const [accentColor, setAccentColor] = useState(store.accentColor);
  const [currency, setCurrency] = useState(store.currency);
  const [taxRate, setTaxRate] = useState(String(store.taxRate));
  const [tableCount, setTableCount] = useState(
    String(store.tableCount ?? BLUEPRINT_LIMITS.TABLE_COUNT_DEFAULT)
  );
  const [address, setAddress] = useState(store.address);
  const [phone, setPhone] = useState(store.phone);
  const [receiptFooter, setReceiptFooter] = useState(store.receiptFooter);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(store.name);
    setBusinessType(store.businessType);
    setLogoDataUrl(store.logoDataUrl);
    setPrimaryColor(store.primaryColor);
    setAccentColor(store.accentColor);
    setCurrency(store.currency);
    setTaxRate(String(store.taxRate));
    setTableCount(String(store.tableCount ?? BLUEPRINT_LIMITS.TABLE_COUNT_DEFAULT));
    setAddress(store.address);
    setPhone(store.phone);
    setReceiptFooter(store.receiptFooter);
  }, [store]);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const compressed = await compressLogoImage(file);
      setLogoDataUrl(compressed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process logo image.');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = name.trim();
    const parsedTax = Number(taxRate || 0);
    if (!cleanName) {
      setError('Brand name cannot be empty.');
      return;
    }
    if (!Number.isFinite(parsedTax) || parsedTax < 0 || parsedTax > BLUEPRINT_LIMITS.TAX_RATE_MAX) {
      setError('Tax rate must be between 0% and 50%.');
      return;
    }
    if (
      !BLUEPRINT_LIMITS.HEX_COLOR_REGEX.test(primaryColor) ||
      !BLUEPRINT_LIMITS.HEX_COLOR_REGEX.test(accentColor)
    ) {
      setError('Colors must be valid 6-digit hex values.');
      return;
    }

    const parsedTables = Math.round(Number(tableCount || BLUEPRINT_LIMITS.TABLE_COUNT_DEFAULT));
    if (
      !Number.isFinite(parsedTables) ||
      parsedTables < 1 ||
      parsedTables > BLUEPRINT_LIMITS.TABLE_COUNT_MAX
    ) {
      setError(`Table count must be between 1 and ${BLUEPRINT_LIMITS.TABLE_COUNT_MAX}.`);
      return;
    }

    setSaving(true);
    setError(null);
    setSavedNotice(false);
    const path = `stores/${store.id}`;
    try {
      await updateDoc(doc(db, 'stores', store.id), {
        name: cleanName.slice(0, BLUEPRINT_LIMITS.STORE_NAME_MAX),
        businessType,
        logoDataUrl: logoDataUrl.slice(0, BLUEPRINT_LIMITS.LOGO_DATA_URL_MAX),
        primaryColor,
        accentColor,
        currency: currency.trim().slice(0, BLUEPRINT_LIMITS.CURRENCY_MAX) || 'PKR',
        taxRate: parsedTax,
        tableCount: parsedTables,
        address: address.trim().slice(0, BLUEPRINT_LIMITS.ADDRESS_MAX),
        phone: phone.trim().slice(0, BLUEPRINT_LIMITS.PHONE_MAX),
        receiptFooter: receiptFooter.trim().slice(0, BLUEPRINT_LIMITS.RECEIPT_FOOTER_MAX),
        updatedAt: serverTimestamp(),
      });
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 2600);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <form onSubmit={handleSave} className="lg:col-span-8 space-y-6">
        {/* Brand Identity & Mode */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
          <div>
            <h2 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
              Brand Identity & Store Mode
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Customize your shop name, logo, receipt details, and business workflow.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setBusinessType('retail')}
              className={`text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                businessType === 'retail'
                  ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Store className="w-4 h-4" />
                <span>Retail / Shop Mode</span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Enables EAN-13 Barcode generator, barcode label printing, and scanner billing.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setBusinessType('restaurant')}
              className={`text-left rounded-lg border p-3.5 transition-colors cursor-pointer ${
                businessType === 'restaurant'
                  ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <UtensilsCrossed className="w-4 h-4" />
                <span>Restaurant / Cafe Mode</span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Hides all barcode features; enables Table Numbers, Dine-In/Takeaway & KOT print.
              </p>
            </button>
          </div>

          {/* Logo Upload */}
          <div className="flex flex-wrap items-center gap-4 pt-1">
            <div className="w-16 h-16 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 flex items-center justify-center overflow-hidden shrink-0">
              {logoDataUrl ? (
                <img
                  src={logoDataUrl}
                  alt="Brand logo preview"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain p-1"
                />
              ) : (
                <span className="text-lg font-bold font-display text-slate-400">
                  {name.slice(0, 2).toUpperCase() || 'BF'}
                </span>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer">
                  <Upload className="w-3.5 h-3.5" />
                  <span>Upload Brand Logo</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={(e) => void handleLogoUpload(e)}
                    className="hidden"
                  />
                </label>
                {logoDataUrl && (
                  <button
                    type="button"
                    onClick={() => setLogoDataUrl('')}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Remove</span>
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Displayed in the POS sidebar and printed on top of thermal bills & Z-Reports.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Brand / Outlet Name
              </label>
              <input
                type="text"
                required
                maxLength={BLUEPRINT_LIMITS.STORE_NAME_MAX}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100"
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Default Tax Rate (%)
              </label>
              <input
                type="number"
                min="0"
                max="50"
                step="0.5"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
              />
            </div>

            {businessType === 'restaurant' && (
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Dine-In Tables Count (1 – {BLUEPRINT_LIMITS.TABLE_COUNT_MAX})
                </label>
                <input
                  type="number"
                  min="1"
                  max={BLUEPRINT_LIMITS.TABLE_COUNT_MAX}
                  step="1"
                  value={tableCount}
                  onChange={(e) => setTableCount(e.target.value)}
                  className="w-full sm:w-48 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Contact Phone
              </label>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.PHONE_MAX}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Shop / Restaurant Address
              </label>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.ADDRESS_MAX}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Receipt Footer Note
              </label>
              <input
                type="text"
                maxLength={BLUEPRINT_LIMITS.RECEIPT_FOOTER_MAX}
                value={receiptFooter}
                onChange={(e) => setReceiptFooter(e.target.value)}
                placeholder="Thank you for shopping with us! Exchange within 7 days with receipt."
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
        </section>

        {/* Color Theme Customization */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
                Color Theme & Appearance
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Match the POS interface to your brand palette.
              </p>
            </div>

            <button
              type="button"
              onClick={onToggleDarkMode}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {THEME_PRESETS.map((preset) => {
              const active = primaryColor.toLowerCase() === preset.primaryColor.toLowerCase();
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    setPrimaryColor(preset.primaryColor);
                    setAccentColor(preset.accentColor);
                  }}
                  className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                    active
                      ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                      : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <span
                    className="w-5 h-5 rounded-md shrink-0"
                    style={{ backgroundColor: preset.primaryColor }}
                  />
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                    {preset.name}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Primary Brand Color
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-10 w-12 rounded border border-slate-200 dark:border-slate-700 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono uppercase text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Secondary Accent Color
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="h-10 w-12 rounded border border-slate-200 dark:border-slate-700 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={accentColor}
                  onChange={(e) => setAccentColor(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono uppercase text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <div>
              {savedNotice && (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <Check className="w-4 h-4" />
                  Brand settings saved & applied live
                </span>
              )}
            </div>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg px-5 py-2.5 text-xs font-semibold text-white transition-opacity disabled:opacity-60 cursor-pointer"
              style={{ backgroundColor: primaryColor }}
            >
              {saving ? 'Saving Settings...' : 'Save Brand Settings'}
            </button>
          </div>
        </section>
      </form>

      {/* Right Column: Live Receipt Header Preview & Windows/Android Deployment Card */}
      <div className="lg:col-span-4 space-y-5">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Live Brand & Receipt Preview
          </div>
          <div className="rounded-lg border border-slate-200 bg-white text-slate-950 p-4 text-center font-mono text-xs">
            {logoDataUrl && (
              <img
                src={logoDataUrl}
                alt="Receipt logo preview"
                referrerPolicy="no-referrer"
                className="mx-auto mb-2 max-h-12 object-contain"
              />
            )}
            <div className="text-sm font-bold font-display">{name || 'Your Brand Name'}</div>
            {address && <div className="text-[11px] text-slate-600 mt-0.5">{address}</div>}
            {phone && <div className="text-[11px] text-slate-600">Tel: {phone}</div>}
            <div className="my-3 border-t border-dashed border-slate-300" />
            <div
              className="w-full rounded py-1.5 text-[11px] font-sans font-semibold text-white"
              style={{ backgroundColor: primaryColor }}
            >
              Primary POS Action Button
            </div>
            <div className="mt-3 text-[10px] text-slate-500">
              {receiptFooter || 'Thank you for your business!'}
            </div>
          </div>
        </div>

        {onOpenPasswordSetup && userEmail && (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold font-display text-slate-900 dark:text-slate-100">
                <KeyRound className="w-4 h-4 brand-text" />
                <span>Email & Password Login</span>
              </div>
              {hasPassword && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Active</span>
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {hasPassword
                ? `Email & password sign-in is enabled for ${userEmail}. You can update your password anytime.`
                : `Create a password for ${userEmail} so next time you can sign in directly with email and password without Google popup.`}
            </p>
            <button
              type="button"
              onClick={onOpenPasswordSetup}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>{hasPassword ? 'Change Password' : 'Create a Password'}</span>
            </button>
          </div>
        )}

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div>
            <h3 className="text-sm font-bold font-display text-slate-900 dark:text-slate-100">
              Windows, Android & Future iOS
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Install BazaarFlow POS directly as a standalone app on Windows PCs and Android tablets—no macOS needed. iOS Safari Add-to-Home-Screen is already bundled for later rollout.
            </p>
          </div>

          <div className="space-y-2.5 text-xs text-slate-600 dark:text-slate-400">
            <div className="flex items-start gap-2">
              <Monitor className="w-4 h-4 shrink-0 text-slate-400 mt-0.5" />
              <span>Windows: Install via Chrome or Edge for fullscreen counter billing and USB barcode scanners.</span>
            </div>
            <div className="flex items-start gap-2">
              <Smartphone className="w-4 h-4 shrink-0 text-slate-400 mt-0.5" />
              <span>Android: Install via Chrome for touch-optimized mobile POS and offline cache.</span>
            </div>
            <div className="flex items-start gap-2">
              <Printer className="w-4 h-4 shrink-0 text-slate-400 mt-0.5" />
              <span>Printers: Works with standard 58mm / 80mm thermal receipt & label printers via OS print dialog.</span>
            </div>
          </div>

          <div className="pt-1">
            <PWAInstallButton />
          </div>
        </div>
      </div>
    </div>
  );
};
