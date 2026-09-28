import React, { useState, useRef, useEffect } from "react";
import { Sun, Moon, Monitor, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface ThemeSelectorProps {
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
}

export function ThemeSelector({ theme, setTheme }: ThemeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && isOpen) {
        event.stopPropagation();
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const getThemeIcon = (t: typeof theme) => {
    switch (t) {
      case "light":
        return <Sun className="w-4 h-4 text-amber-500 fill-amber-100/50" />;
      case "dark":
        return <Moon className="w-4 h-4 text-indigo-400 fill-indigo-950/40" />;
      case "system":
        return <Monitor className="w-4 h-4 text-slate-500 dark:text-slate-400" />;
    }
  };

  const options: { value: typeof theme; title: string; icon: React.ReactNode }[] = [
    {
      value: "light",
      title: "Light Theme",
      icon: <Sun className="w-4 h-4 text-amber-500 fill-amber-100/20" />,
    },
    {
      value: "dark",
      title: "Dark Theme",
      icon: <Moon className="w-4 h-4 text-indigo-400 fill-indigo-950/20" />,
    },
    {
      value: "system",
      title: "System Theme",
      icon: <Monitor className="w-4 h-4 text-slate-500 dark:text-slate-400" />,
    },
  ];

  return (
    <div ref={containerRef} className="relative select-none z-40">
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label="Choose Theme"
        data-tooltip="Choose Theme"
        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/80 text-slate-700 dark:text-slate-200 transition-all cursor-pointer shadow-xs tooltip-left"
      >
        <span className="flex items-center justify-center">
          {getThemeIcon(theme)}
        </span>
        <ChevronDown
          className={`w-3 h-3 text-slate-400 dark:text-slate-500 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {/* Pop-up Dropdown Menu */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute right-0 mt-1.5 rounded-xl bg-white dark:bg-slate-950 border border-slate-200/90 dark:border-slate-800/90 p-1 shadow-lg dark:shadow-2xl z-50 flex flex-col gap-0.5 min-w-[48px]"
            role="listbox"
          >
            {options.map((opt) => {
              const isSelected = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  aria-label={opt.title}
                  data-tooltip={opt.title}
                  onClick={() => {
                    setTheme(opt.value);
                    setIsOpen(false);
                  }}
                  className={`p-2 rounded-lg transition-all duration-150 flex items-center justify-center cursor-pointer relative tooltip-left ${
                    isSelected
                      ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400"
                      : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  <span className="flex-shrink-0">{opt.icon}</span>
                  {isSelected && (
                    <span className="absolute right-1 top-1 w-1 h-1 rounded-full bg-indigo-600 dark:bg-indigo-400 animate-pulse" />
                  )}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
