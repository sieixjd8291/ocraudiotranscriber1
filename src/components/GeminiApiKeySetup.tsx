import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Key, CheckCircle2, Loader2, X, ExternalLink, ArrowRight, ShieldCheck, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface GeminiApiKeySetupProps {
  apiKey: string;
  setApiKey: (key: string) => void;
}

export function GeminiApiKeySetup({ apiKey, setApiKey }: GeminiApiKeySetupProps) {
  const [showModal, setShowModal] = useState(false);
  const [tempKey, setTempKey] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const handleOpenSettings = () => openSettingsModal();
    window.addEventListener("open-gemini-settings", handleOpenSettings);
    return () => window.removeEventListener("open-gemini-settings", handleOpenSettings);
  }, [apiKey]);

  // Close the modal when the Escape key is pressed
  useEffect(() => {
    if (!showModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isVerifying) {
        e.stopPropagation();
        setShowModal(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showModal, isVerifying]);

  const openSettingsModal = () => {
    setTempKey(localStorage.getItem("gemini_api_key") || "");
    setError(null);
    setShowModal(true);
  };

  const verifyGeminiKey = async (keyToVerify: string): Promise<void> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
        headers: { "x-goog-api-key": keyToVerify },
        signal: controller.signal,
        cache: "no-store",
      });
      if (response.ok) return;

      if (response.status === 400 || response.status === 401) {
        throw new Error("This Gemini API key is invalid. Check the key and try again.");
      }
      if (response.status === 403) {
        throw new Error("This key cannot access the Gemini API. Check its API restrictions and project permissions.");
      }
      throw new Error("Gemini could not verify the key right now. Please try again shortly.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Gemini key verification timed out. Please try again.");
      }
      if (error instanceof TypeError) {
        throw new Error("Could not reach Gemini to verify the key. Check your connection and try again.");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const Banner = apiKey ? (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 theme-card-bg theme-border theme-shadow p-5 rounded-2xl mb-6">
      <div className="flex items-center gap-4">
        <button
          onClick={openSettingsModal}
          className="p-3 rounded-xl shadow-inner bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50 text-emerald-600 transition-colors cursor-pointer ring-1 ring-emerald-500/20"
          data-tooltip="Open Gemini Settings"
          aria-label="Open Gemini Settings"
        >
          <Key className="w-6 h-6" />
        </button>
        <div>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            Gemini Transcription Active <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5 max-w-xl">
            Connected successfully. API queries for transcription and OCR process securely from your browser.
          </p>
        </div>
      </div>
      <button
        onClick={() => {
          localStorage.removeItem("gemini_api_key");
          setApiKey("");
        }}
        className="self-center sm:self-auto px-4 py-2 border border-slate-200 dark:border-slate-800 text-xs font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-xl transition duration-200 cursor-pointer whitespace-nowrap"
      >
        Disconnect Key
      </button>
    </div>
  ) : (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 theme-card-bg theme-border theme-shadow p-5 rounded-2xl mb-6">
      <div className="flex items-center gap-4">
        <button
          onClick={openSettingsModal}
          className="p-3 rounded-xl shadow-inner bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/30 dark:hover:bg-amber-950/50 text-amber-600 transition-colors cursor-pointer ring-1 ring-amber-500/20"
          data-tooltip="Open Gemini Settings"
          aria-label="Open Gemini Settings"
        >
          <Key className="w-6 h-6" />
        </button>
        <div>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-200">
            No Gemini API Key Connected
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mt-0.5">
            Connect your own Gemini API key for transcription and OCR to run requests directly in your browser.
          </p>
        </div>
      </div>
      <button
        onClick={openSettingsModal}
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white text-xs font-bold rounded-xl shadow-md transition duration-200 cursor-pointer whitespace-nowrap"
      >
        Connect Gemini Key
      </button>
    </div>
  );

  const handleGetApiKey = () => {
    window.open("https://aistudio.google.com/app/apikey", "_blank");
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
      await verifyGeminiKey(trimmed);
      localStorage.setItem("gemini_api_key", trimmed);
      setApiKey(trimmed);
      setShowModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the Gemini API key. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  };

  const Modal = mounted ? createPortal(
    <AnimatePresence>
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => { if (!isVerifying) setShowModal(false); }}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs cursor-pointer"
          />
          
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
                Connect Gemini API
              </h2>
              <button 
                onClick={() => setShowModal(false)}
                disabled={isVerifying}
                aria-label="Close Gemini settings"
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="px-6 py-5 flex flex-col gap-4">
              <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Connect your Gemini API key. We verify the key without starting a transcription or using a generation model.
              </div>

              <div className="bg-slate-50 dark:bg-slate-950 rounded-xl p-3 border border-slate-100 dark:border-slate-800 flex flex-col gap-3">
                <button
                  onClick={handleGetApiKey}
                  className="flex items-center justify-center gap-2 w-full py-2 px-4 bg-white dark:bg-slate-800 border-2 border-indigo-100 dark:border-indigo-900/50 hover:border-indigo-300 text-indigo-600 dark:text-indigo-400 font-bold rounded-lg text-xs transition-all cursor-pointer shadow-xs active:scale-[0.98]"
                >
                  Get Gemini API Key <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="gemini-key-input" className="text-[10px] font-extrabold text-slate-700 dark:text-slate-400 pl-1 uppercase tracking-wider">
                  Your Gemini API Key
                </label>
                <input
                  id="gemini-key-input"
                  type="password"
                  aria-label="Your Gemini API Key"
                  placeholder="AIzaSy..."
                  value={tempKey}
                  onChange={(e) => {
                    setTempKey(e.target.value);
                    if (error) setError(null);
                  }}
                  disabled={isVerifying}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && !isVerifying) handleSave();
                  }}
                  className={`w-full bg-white dark:bg-slate-900 border ${error ? 'border-red-400 focus:ring-red-500/20' : 'border-slate-300 dark:border-slate-800 focus:ring-indigo-500/20'} rounded-xl px-4 py-2.5 text-xs text-slate-800 dark:text-slate-100 outline-none focus:border-indigo-500 transition-all shadow-xs`}
                />

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
                  localStorage.removeItem("gemini_api_key");
                  setApiKey("");
                  setTempKey("");
                }}
                disabled={isVerifying}
                className="flex items-center justify-center gap-1.5 h-10 px-4 text-xs font-bold text-red-600 disabled:opacity-50 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-xl transition-all cursor-pointer shadow-xs border border-red-100 dark:border-red-950/30 w-full sm:w-auto shrink-0 whitespace-nowrap"
              >
                <Trash2 className="w-4 h-4 text-red-500 shrink-0" />
                Remove Key
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
    </>
  );
}
