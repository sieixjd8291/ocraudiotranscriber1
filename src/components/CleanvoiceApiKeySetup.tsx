import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Key, CheckCircle2, Loader2, X, ExternalLink, ArrowRight, ShieldCheck, Trash2, Mail, Coins, RefreshCw, ChevronDown, Check, Globe } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { verifyApiKey, getCleanvoiceAccountCredits } from "../services/cleanvoiceService";

interface CleanvoiceApiKeySetupProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  remainingCredits?: number | null;
}

interface MailProvider {
  id: string;
  label: string;
  url: string;
}

// Available webmail providers for the "Go to Mail" picker.
const MAIL_PROVIDERS: MailProvider[] = [
  { id: "gmail", label: "Gmail", url: "https://mail.google.com" },
  { id: "outlook", label: "Outlook", url: "https://outlook.live.com/" },
  { id: "proton", label: "ProtonMail", url: "https://mail.proton.me/u/0/inbox" },
  { id: "yahoo", label: "Yahoo Mail", url: "https://mail.yahoo.com/" },
];

const MAIL_PROVIDER_STORAGE_KEY = "cleanvoice_mail_provider";

export function CleanvoiceApiKeySetup({ apiKey, setApiKey, remainingCredits }: CleanvoiceApiKeySetupProps) {
  const [showModal, setShowModal] = useState(false);
  const [tempKey, setTempKey] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const [internalCredits, setInternalCredits] = useState<number | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // "Go to Mail" provider picker state
  const [mailMenuOpen, setMailMenuOpen] = useState(false);
  const [savedMailProvider, setSavedMailProvider] = useState<MailProvider | null>(() => {
    try {
      const raw = localStorage.getItem(MAIL_PROVIDER_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as MailProvider) : null;
    } catch {
      return null;
    }
  });
  const [customMailUrl, setCustomMailUrl] = useState("");
  const [showCustomMail, setShowCustomMail] = useState(false);
  const mailMenuRef = useRef<HTMLDivElement>(null);
  const mailPanelRef = useRef<HTMLDivElement>(null);
  // Viewport coordinates for the portal-rendered dropdown (avoids being clipped
  // by the modal's overflow-hidden container).
  const [mailMenuPos, setMailMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (remainingCredits !== undefined && remainingCredits !== null) {
      setInternalCredits(remainingCredits);
    }
  }, [remainingCredits]);

  const fetchLocalCredits = async (keyToUse = apiKey) => {
    if (!keyToUse) return;
    setIsSyncing(true);
    setSyncError(null);
    try {
      const credits = await getCleanvoiceAccountCredits(keyToUse);
      if (credits !== undefined && credits !== null && !isNaN(credits)) {
        setInternalCredits(credits);
        // Dispatch custom event so App.tsx can synchronize its central state
        window.dispatchEvent(new CustomEvent("cleanvoice-credits-updated", { detail: credits }));
      } else {
        setSyncError("Could not retrieve balance. Check API limits or key validity.");
      }
    } catch (e) {
      console.warn("Failed checking credits:", e);
      setSyncError("Network error checking remaining credits.");
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    if (apiKey) {
      fetchLocalCredits(apiKey);
    } else {
      setInternalCredits(null);
      setSyncError(null);
    }
  }, [apiKey]);

  useEffect(() => {
    const handleRefresh = () => {
      if (apiKey) {
        fetchLocalCredits(apiKey);
      }
    };
    window.addEventListener("cleanvoice-refresh-credits", handleRefresh);
    return () => {
      window.removeEventListener("cleanvoice-refresh-credits", handleRefresh);
    };
  }, [apiKey]);

  useEffect(() => {
    setMounted(true);

    const handleOpenSettings = () => openSettingsModal();
    window.addEventListener("open-cleanvoice-settings", handleOpenSettings);
    return () => window.removeEventListener("open-cleanvoice-settings", handleOpenSettings);
  }, [apiKey]);

  // Close the modal when the Escape key is pressed
  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowModal(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showModal]);

  // Close the "Go to Mail" dropdown when clicking outside of it (covers both
  // the in-modal trigger and the portal-rendered dropdown panel).
  useEffect(() => {
    if (!mailMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (mailMenuRef.current && mailMenuRef.current.contains(target)) ||
        (mailPanelRef.current && mailPanelRef.current.contains(target))
      ) {
        return;
      }
      setMailMenuOpen(false);
      setShowCustomMail(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [mailMenuOpen]);

  // Reset the mail dropdown whenever the settings modal is closed
  useEffect(() => {
    if (!showModal) {
      setMailMenuOpen(false);
      setShowCustomMail(false);
      setCustomMailUrl("");
      setMailMenuPos(null);
    }
  }, [showModal]);

  useEffect(() => {
    const handleDisconnect = () => {
      setApiKey("");
      setTempKey("");
      setError(null);
    };
    window.addEventListener("cleanvoice-key-disconnected", handleDisconnect);
    return () => {
      window.removeEventListener("cleanvoice-key-disconnected", handleDisconnect);
    };
  }, [setApiKey]);

  const openSettingsModal = () => {
    // Strictly prevent opening Cleanvoice settings if we're not currently on the Cleanvoice tab
    if (typeof window !== "undefined" && (window as any).activeAppTool !== "cleanvoice") {
      return;
    }
    setTempKey(localStorage.getItem("cleanvoice_api_key") || "");
    setError(null);
    setShowModal(true);
  };

  const Banner = apiKey ? (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 theme-card-bg theme-border theme-shadow p-5">
      <div className="flex items-center gap-4">
        <button
          onClick={openSettingsModal}
          className="p-3 rounded-xl shadow-inner bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50 text-emerald-600 transition-colors cursor-pointer ring-1 ring-emerald-500/20"
          data-tooltip="Open Cleanvoice Settings"
          aria-label="Open Cleanvoice Settings"
        >
          <Key className="w-6 h-6" />
        </button>
        <div>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            Cleanvoice Integration Active <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5 max-w-xl">
            Connected successfully. Key: {apiKey.substring(0, 8)}... (API uploads process headlessly).
          </p>
          
          <div className="flex flex-col gap-2 mt-2.5">
            {internalCredits !== null && internalCredits !== undefined && !isNaN(internalCredits) ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  disabled={isSyncing}
                  onClick={() => fetchLocalCredits()}
                  className="inline-flex items-center gap-2 bg-amber-50 dark:bg-amber-900/30 hover:bg-amber-100/60 dark:hover:bg-amber-800/40 border border-amber-200/50 dark:border-amber-700/50 text-amber-700 dark:text-amber-300 text-xs px-3 py-1.5 rounded-lg font-semibold shadow-xs cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-90 disabled:cursor-wait select-none group"
                  data-tooltip="Click to refresh your remaining balance"
                >
                  {isSyncing ? (
                    <RefreshCw className="w-3.5 h-3.5 text-amber-500 animate-spin" />
                  ) : (
                    <Coins className="w-3.5 h-3.5 text-amber-500 group-hover:drop-shadow-[0_0_4px_rgba(245,158,11,0.6)]" />
                  )}
                  <span>
                    Remaining Credits:{" "}
                    <strong className="text-amber-900 dark:text-amber-100 text-sm font-extrabold pr-0.5">
                      {internalCredits}
                    </strong>{" "}
                    {internalCredits === 1 ? "minute" : "minutes"}
                  </span>
                  
                  {isSyncing ? (
                    <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80 font-normal ml-0.5 animate-pulse">
                      (Syncing...)
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 font-normal ml-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      Sync ↻
                    </span>
                  )}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <button 
                  disabled={isSyncing}
                  onClick={() => fetchLocalCredits()}
                  className="inline-flex items-center gap-2 bg-slate-50 hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 text-xs px-3 py-1.5 rounded-lg font-semibold text-slate-600 dark:text-slate-300 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:cursor-wait select-none"
                  data-tooltip="Click to check remaining balance"
                >
                  {isSyncing ? (
                    <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                  ) : (
                    <Coins className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                  )}
                  <span>{isSyncing ? "Checking API limits..." : "Check remaining balance"}</span>
                </button>
              </div>
            )}

            {syncError && (
              <div className="text-[11px] text-red-500 pr-2.5 pl-1.5 py-0.5 bg-red-50 dark:bg-red-950/10 border border-red-105 dark:border-red-950/20 rounded-md w-fit font-medium flex items-center gap-1 select-none animate-fade-in">
                <span>⚠️ {syncError}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={() => {
          localStorage.removeItem("cleanvoice_api_key");
          setApiKey("");
          window.dispatchEvent(new Event("cleanvoice-key-disconnected"));
        }}
        className="px-4 py-2 border border-slate-200 dark:border-slate-800 text-xs font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-xl transition duration-200 cursor-pointer whitespace-nowrap"
      >
        Disconnect Key
      </button>
    </div>
  ) : (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 theme-card-bg theme-border theme-shadow p-5">
      <div className="flex items-center gap-4">
        <button
          onClick={openSettingsModal}
          className="p-3 rounded-xl shadow-inner bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-800/40 text-amber-600 dark:text-amber-500 transition-colors cursor-pointer ring-1 ring-amber-500/20"
          data-tooltip="Open Cleanvoice Settings"
          aria-label="Open Cleanvoice Settings"
        >
          <Key className="w-6 h-6" />
        </button>
        <div>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-200">
            No Cleanvoice API Key Connected
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5">
            Connect your active key to run real requests.
          </p>
        </div>
      </div>
      <button
        onClick={openSettingsModal}
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white text-xs font-bold rounded-xl shadow-md transition duration-200 cursor-pointer whitespace-nowrap"
      >
        Connect API Key
      </button>
    </div>
  );

  const handleGetApiKey = () => {
    // Open cleanvoice dev page
    window.open("https://app.cleanvoice.ai/developer/api-keys", "_blank");
  };

  const openMailUrl = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // Measure the trigger button and place the dropdown just below it in viewport
  // coordinates, so a portal-rendered panel stays aligned even though the modal
  // container clips its overflow.
  const positionDropdown = () => {
    const trigger = mailMenuRef.current?.querySelector("[data-mail-trigger]");
    if (!trigger) return;
    const rect = (trigger as HTMLElement).getBoundingClientRect();
    setMailMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  };

  const toggleMailMenu = () => {
    if (!mailMenuOpen) {
      positionDropdown();
    }
    setMailMenuOpen((open) => !open);
    setShowCustomMail(false);
  };

  const pickMailProvider = (provider: MailProvider) => {
    try {
      localStorage.setItem(MAIL_PROVIDER_STORAGE_KEY, JSON.stringify(provider));
    } catch {
      /* ignore persistence failures (e.g. private mode) */
    }
    setSavedMailProvider(provider);
    setMailMenuOpen(false);
    setShowCustomMail(false);
    openMailUrl(provider.url);
  };

  // Smart behaviour: open the remembered provider directly, otherwise show the picker
  const handleGoToMail = () => {
    if (savedMailProvider) {
      openMailUrl(savedMailProvider.url);
    } else {
      toggleMailMenu();
    }
  };

  const openCustomMail = () => {
    const trimmed = customMailUrl.trim();
    if (!trimmed) return;
    // Auto-prefix https:// if the user omitted a scheme
    let url = trimmed;
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }
    try {
      // Validate the resulting URL before opening
      new URL(url);
    } catch {
      return;
    }
    pickMailProvider({ id: "custom", label: "Custom webmail", url });
    setCustomMailUrl("");
  };

  const handleSave = async () => {
    const trimmed = tempKey.trim();
    if (!trimmed) {
      setError("API Key cannot be empty.");
      return;
    }

    setIsVerifying(true);
    setError(null);
    try {
      const isValid = await verifyApiKey(trimmed);
      if (isValid) {
        localStorage.setItem("cleanvoice_api_key", trimmed);
        localStorage.removeItem("cleanvoice_api_key_disconnected");
        setApiKey(trimmed);
        window.dispatchEvent(new CustomEvent("cleanvoice-key-connected", { detail: trimmed }));
        setShowModal(false);
      } else {
        setError("Invalid API Key. Please verify and try again.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to verify key.");
    } finally {
      setIsVerifying(false);
    }
  };

  const Modal = mounted ? createPortal(
    <AnimatePresence>
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Subtle backdrop blend with fade animation */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setShowModal(false)}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs cursor-pointer"
          />
          
          {/* Modal box with scale-95 to scale-100 transition */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col relative z-20"
          >
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-indigo-500" />
                Connect Cleanvoice API
              </h2>
              <button 
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="px-6 py-3.5 flex flex-col gap-3.5">
              <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Link your Cleanvoice account to enable AI audio processing directly in this application.
              </div>

              <div className="bg-slate-50 dark:bg-slate-950 rounded-xl p-3 border border-slate-100 dark:border-slate-800 flex flex-col gap-3">
                <button
                  onClick={handleGetApiKey}
                  className="flex items-center justify-center gap-2 w-full py-2 px-4 bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-indigo-900/50 hover:border-indigo-300 text-indigo-600 dark:text-indigo-400 font-bold rounded-lg text-xs transition-all cursor-pointer shadow-xs active:scale-[0.98]"
                >
                  Get Cleanvoice API Key <ExternalLink className="w-3.5 h-3.5" />
                </button>
                <div ref={mailMenuRef} className="relative">
                  <div
                    data-mail-trigger
                    className="flex items-stretch w-full bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-indigo-900/50 hover:border-indigo-300 rounded-lg shadow-xs transition-all overflow-hidden"
                  >
                    <button
                      onClick={handleGoToMail}
                      data-tooltip={savedMailProvider ? `Open ${savedMailProvider.label}` : "Choose your mail provider"}
                      className="flex-1 flex items-center justify-center gap-2 py-2 px-4 text-indigo-600 dark:text-indigo-400 font-bold text-xs transition-all cursor-pointer active:scale-[0.98]"
                    >
                      <Mail className="w-3.5 h-3.5" /> Go to Mail <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={toggleMailMenu}
                      data-tooltip="Switch mail provider"
                      aria-label="Switch mail provider"
                      aria-expanded={mailMenuOpen}
                      className="flex items-center justify-center w-8 border-l border-indigo-100 dark:border-indigo-900/50 text-indigo-600 dark:text-indigo-400 cursor-pointer transition-colors hover:bg-indigo-50 dark:hover:bg-indigo-950/40"
                    >
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${mailMenuOpen ? "rotate-180" : ""}`} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="cleanvoice-key-input" className="text-[10px] font-extrabold text-slate-700 dark:text-slate-350 pl-1 uppercase tracking-wider">
                  Your API Key
                </label>
                <div className="relative border-b-0">
                  <input
                    id="cleanvoice-key-input"
                    type="password"
                    aria-label="Your Cleanvoice API Key"
                    placeholder="Paste your key here..."
                    value={tempKey}
                    onChange={(e) => {
                      setTempKey(e.target.value);
                      if (error) setError(null);
                    }}
                    disabled={isVerifying}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSave();
                    }}
                    className={`w-full bg-white dark:bg-slate-900 border ${error ? 'border-red-400 focus:ring-red-500/20' : 'border-slate-250 dark:border-slate-800 focus:ring-indigo-500/20'} rounded-xl px-4 py-2.5 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-indigo-500 transition-all shadow-xs`}
                  />
                </div>
                
                <div className="text-[11px] text-slate-500 dark:text-slate-400 pl-1">
                  Not signed up? <a href="https://app.cleanvoice.ai/register" target="_blank" rel="noopener noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline font-bold cursor-pointer">Register here</a> or <a href="https://app.cleanvoice.ai/login" target="_blank" rel="noopener noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline font-bold cursor-pointer">Login here</a> to get your key.
                </div>

                {error && (
                  <div className="text-xs text-red-500 font-medium pl-1 animate-fade-in-up flex items-center gap-1 mt-1">
                    {error}
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-800 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 w-full">
              <button
                onClick={() => {
                  window.open("https://app.cleanvoice.ai/settings", "_blank");
                  localStorage.removeItem("cleanvoice_api_key");
                  setApiKey("");
                  setTempKey("");
                  window.dispatchEvent(new Event("cleanvoice-key-disconnected"));
                }}
                className="flex items-center justify-center gap-1.5 h-10 px-4 text-xs font-bold text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-xl transition-all cursor-pointer shadow-xs border border-red-100 dark:border-red-950/30 w-full sm:w-auto shrink-0 whitespace-nowrap"
              >
                <Trash2 className="w-4 h-4 text-red-500 shrink-0" />
                Delete Account
              </button>

              <div className="flex gap-2.5 w-full sm:w-auto">
                <button
                  onClick={() => setShowModal(false)}
                  disabled={isVerifying}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 h-10 px-4 text-xs font-bold text-slate-600 dark:text-slate-350 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-all cursor-pointer shadow-xs disabled:opacity-50 shrink-0 whitespace-nowrap"
                >
                  <X className="w-4 h-4 shrink-0" />
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={isVerifying || !tempKey.trim()}
                  className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 h-10 px-5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl shadow-md transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed hover:-translate-y-0.5 active:translate-y-0 shrink-0 whitespace-nowrap"
                >
                  {isVerifying ? (
                    <><Loader2 className="w-4 h-4 animate-spin shrink-0" /> Verifying...</>
                  ) : (
                    <>
                      <span>Save</span>
                      <ArrowRight className="w-4 h-4 shrink-0" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  ) : null;


  return (
    <>
      {Banner}
      {Modal}
      {/* Provider dropdown is portaled to document.body so the modal's
          overflow-hidden container cannot clip it. */}
      {mounted && mailMenuOpen && mailMenuPos ? createPortal(
        <div
          ref={mailPanelRef}
          style={{ position: "fixed", top: mailMenuPos.top, left: mailMenuPos.left, width: mailMenuPos.width }}
          className="z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-700">
            Choose your mail provider
          </div>
          <div className="p-1">
            {MAIL_PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                onClick={() => pickMailProvider(provider)}
                className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-md text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <Mail className="w-3.5 h-3.5 text-indigo-500" />
                  {provider.label}
                </span>
                {savedMailProvider?.id === provider.id && (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                )}
              </button>
            ))}

            <button
              onClick={() => setShowCustomMail((s) => !s)}
              className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-md text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-indigo-500" />
                Other webmail
              </span>
              {savedMailProvider?.id === "custom" && (
                <Check className="w-3.5 h-3.5 text-emerald-500" />
              )}
            </button>

            {showCustomMail && (
              <div className="flex items-center gap-1.5 px-1 py-1">
                <input
                  type="text"
                  value={customMailUrl}
                  onChange={(e) => setCustomMailUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      openCustomMail();
                    }
                  }}
                  placeholder="your-provider.com"
                  aria-label="Custom webmail provider domain"
                  className="flex-1 min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 text-[11px] text-slate-800 dark:text-slate-100 outline-none focus:border-indigo-500 transition-colors"
                />
                <button
                  onClick={openCustomMail}
                  className="shrink-0 px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold rounded-md cursor-pointer transition-colors"
                >
                  Open
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      ) : null}
    </>
  );
}
