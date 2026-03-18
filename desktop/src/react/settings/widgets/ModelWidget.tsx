import React, { useState, useRef, useEffect } from 'react';

interface ModelWidgetProps {
  providers: Record<string, { models?: string[]; base_url?: string }>;
  favorites: Set<string>;
  value: string;
  onSelect: (modelId: string) => void;
  onToggleFavorite?: (modelId: string, isFav: boolean) => void;
  placeholder?: string;
  lookupModelMeta?: (id: string) => any;
  formatContext?: (n: number) => string;
  filterModel?: (modelId: string) => boolean;
  emptyText?: string;
}

export function ModelWidget({
  providers,
  favorites,
  value,
  onSelect,
  onToggleFavorite,
  placeholder,
  lookupModelMeta,
  formatContext,
  filterModel,
  emptyText,
}: ModelWidgetProps) {
  const t = (window as any).t || ((k: string) => k);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setSearch('');
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const query = search.toLowerCase();
  const filteredFavorites = [...favorites]
    .filter(mid => !filterModel || filterModel(mid))
    .filter(mid => !query || mid.toLowerCase().includes(query));

  const handleCustomSubmit = () => {
    const val = customInput.trim();
    if (!val) return;
    if (!favorites.has(val)) onToggleFavorite?.(val, true);
    onSelect(val);
    setCustomInput('');
    setOpen(false);
  };

  return (
    <div className="mdw" ref={ref}>
      <button
        className="mdw-trigger"
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <span className="mdw-value">{value || `- ${placeholder || t('settings.api.selectModel')} -`}</span>
        <span className="mdw-arrow">▾</span>
      </button>
      <div className={`mdw-popup${open ? ' open' : ''}`}>
        <input
          ref={searchRef}
          className="mdw-search"
          type="text"
          placeholder={t('settings.api.searchModel')}
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <div className="mdw-options">
          {filteredFavorites.length === 0 && (
            <div className="mdw-empty">{emptyText || t('settings.api.noModels')}</div>
          )}
          {filteredFavorites.map(mid => {
            const meta = lookupModelMeta?.(mid);
            return (
              <button
                key={mid}
                className={`mdw-option${mid === value ? ' selected' : ''}`}
                type="button"
                onClick={() => { onSelect(mid); setOpen(false); }}
              >
                <span className="mdw-option-name">{mid}</span>
                {meta?.context && formatContext && (
                  <span className="mdw-option-ctx">{formatContext(meta.context)}</span>
                )}
              </button>
            );
          })}
          <div className="mdw-custom-row">
            <input
              type="text"
              className="mdw-custom-input"
              placeholder={t('settings.api.customInput')}
              spellCheck={false}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomSubmit();
                e.stopPropagation();
              }}
            />
            <button
              type="button"
              className="mdw-custom-confirm"
              onClick={(e) => { e.stopPropagation(); handleCustomSubmit(); }}
            >
              {'->'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
