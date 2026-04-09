/**
 * Simple in-memory cache with TTL support
 * Reduces database queries for frequently accessed, slow-changing data
 */

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class MemoryCache {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Limpiar entradas expiradas cada 5 minutos
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Obtener valor del cache
   * @param key Clave del cache
   * @returns Valor cacheado o undefined si no existe o expiró
   */
  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data;
  }

  /**
   * Guardar valor en cache
   * @param key Clave del cache
   * @param data Datos a cachear
   * @param ttlMs Tiempo de vida en milisegundos (default: 10 minutos)
   */
  set<T>(key: string, data: T, ttlMs: number = 10 * 60 * 1000): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /**
   * Eliminar valor del cache
   * @param key Clave del cache
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Eliminar valores que coincidan con un patrón
   * @param pattern Patrón a buscar (usa startsWith)
   */
  deletePattern(pattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Limpiar todo el cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Limpiar entradas expiradas
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Obtener o calcular valor (helper para uso común)
   * @param key Clave del cache
   * @param fetcher Función para obtener el valor si no está en cache
   * @param ttlMs Tiempo de vida en milisegundos
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number = 10 * 60 * 1000
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      console.log(`[Cache] HIT: ${key}`);
      return cached;
    }

    console.log(`[Cache] MISS: ${key}`);
    const data = await fetcher();
    this.set(key, data, ttlMs);
    return data;
  }

  /**
   * Estadísticas del cache
   */
  stats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Detener el intervalo de limpieza (para tests o shutdown)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Instancia singleton del cache
export const cache = new MemoryCache();

// TTLs predefinidos para diferentes tipos de datos
export const CACHE_TTL = {
  // Datos que cambian muy poco (filtros, catálogos)
  FILTER_OPTIONS: 60 * 60 * 1000, // 1 hora — estados, plazas, formatos casi nunca cambian
  CATORCENAS: 2 * 60 * 60 * 1000, // 2 horas

  // Datos que cambian moderadamente
  DASHBOARD_STATS: 10 * 60 * 1000, // 10 minutos — reduce DB hits con 150 usuarios
  INVENTORY_COUNTS: 10 * 60 * 1000, // 10 minutos

  // Datos que cambian frecuentemente
  NOTIFICATIONS_STATS: 5 * 60 * 1000, // 5 minutos

  // Cache corto para datos volátiles
  SHORT: 2 * 60 * 1000, // 2 minutos
};

// Claves de cache predefinidas
export const CACHE_KEYS = {
  FILTER_OPTIONS: 'dashboard:filter-options',
  CATORCENAS: 'dashboard:catorcenas',
  DASHBOARD_STATS: (filters: string) => `dashboard:stats:${filters}`,
  INVENTORY_DETAIL: (filters: string) => `dashboard:inventory:${filters}`,
  CAMPANAS_LIST: (filters: string) => `campanas:list:${filters}`,
  PROPUESTAS_LIST: (filters: string) => `propuestas:list:${filters}`,
  SOLICITUDES_LIST: (filters: string) => `solicitudes:list:${filters}`,
};

export default cache;
