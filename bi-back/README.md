# bi-back

Backend del BI de QEB. Sirve el **Resumen de Ventas** leyendo la vista `V_APS_Globales`
de QEB (**solo SELECT**) y expone una **meta mensual editable** (`bi_presupuesto`, tabla
nueva y aislada — la única escritura).

> Este código vive en `qeb-Back/bi-back/` (antes era el repo `Develop-QEB/bi-back`,
> desplegado en Render). Es un paquete **independiente** de qeb-Back: su propio
> `package.json`, `tsconfig` y lockfile, y el `tsc` de qeb-Back no lo compila.

## Correr (local)

```bash
cd bi-back
cp .env.example .env      # llena BI_DB_*, BI_WDB_* y BI_JWT_SECRET
npm install
npm run dev               # http://localhost:3001
```

Todas las variables llevan prefijo `BI_` (ver `.env.example`) para no chocar con las de
qeb-Back. `BI_JWT_SECRET` es obligatoria y debe ser distinta del `JWT_SECRET` de qeb-Back.

Para **construir/producción**: `npm run build && npm start`.

Si también corres qeb-Back en local, arráncalo con `npx nodemon --ignore bi-back/ --exec ts-node src/server.ts`
para que editar bi no reinicie qeb-Back (ni repita sus tareas de arranque).

## Despliegue (DigitalOcean App Platform)

Corre como un **componente aparte** (`bi-back`) dentro de la app de qeb-Back, sin tocar
el componente de qeb-Back:

- Repo `Develop-QEB/qeb-Back`, misma rama que la app, **source_dir `bi-back`**.
- Build: el buildpack de Node (`npm ci` + `npm run build`). Run: `npm start`.
- `http_port: 8080` y `BI_PORT=8080`. Health check HTTP en **`/`** (no toca la BD; `/health` sí).
- Ruta de ingress **`/bi`** con `preserve_path_prefix: false` (App Platform quita el prefijo:
  `/bi/auth/login` llega como `/auth/login` y `wss://…/bi/ws/historial` como `/ws/historial`).
- Variables `BI_*` a **nivel componente** (las sensibles como SECRET). No definir `BI_SEED_KEY`.
- En bi-front: `VITE_API_URL=https://<host-de-la-app>/bi` (sin `/` final) y redeploy.

Una app que **no** define este componente (p. ej. la de producción de qeb-Back) no se ve
afectada: la carpeta queda como archivos sin usar.

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/health` | ping + prueba de conexión |
| GET | `/resumen-ventas?base=&cliente=&anio=&mes=` | el objeto `ResumenVentas` (mismo contrato que el front) |
| GET | `/clientes` | lista de clientes para el filtro |
| GET | `/anios` | años con datos |
| GET | `/presupuesto?anio=&base=` | las 12 metas del año |
| PUT | `/presupuesto` | guarda una meta `{anio,mes,base,monto}` (el lapicito) |

`base` = `CIMU` \| `Trade` \| `SAP` (vacío = todas). Hoy QEB solo tiene `CIMU` y `TRADE`.

## Seguridad de datos

- Todo es **SELECT** sobre las vistas productivas de QEB.
- La **única escritura** es la tabla nueva `bi_presupuesto`. Por seguridad **no se crea
  sola**: ponla con `BI_ALLOW_CREATE=true` o corre `sql/bi_presupuesto.sql` una vez.
  Sin eso, el presupuesto responde `0` y nada se modifica.

## Pendientes / supuestos (ajustar contra el Power BI de IMU)

- **Año anterior**: sale de `V_APS_Globales` con `Año`=anio−1. Hoy solo hay 2026 → da 0.
  Cuando haya histórico 2025 en la vista, se llena solo.
- **Definición de venta**: `BI_VENTA_DEF=TOTAL` (todo el Monto Total) o `VENTA` (solo `U_dscTAsig='Venta'`).
- **Semana**: ISO−1 (convención IMU) sobre `Fecha`. Cambiar `USA_SEMANA_IMU` en el service si no.
- **SAP**: el filtro existe en el front pero QEB no tiene base `SAP` (solo CIMU/TRADE).
