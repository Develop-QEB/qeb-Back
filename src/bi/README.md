# BI (QEBI) dentro de qeb-Back

Backend del BI de QEB. Sirve el **Resumen de Ventas** leyendo la vista `V_APS_Globales`
de QEB (**solo SELECT**) y expone una **meta mensual editable** (`bi_presupuesto`, tabla
nueva y aislada — la única escritura). Usuarios y objetivos viven en su propia BD (QEBI).

> Antes era el repo `Develop-QEB/bi-back`, desplegado en Render. Ahora corre **dentro del
> proceso de qeb-Back**, bajo el prefijo `/bi`, y se enciende por app con `BI_ENABLED=true`.

## Cómo se engancha

- `src/server.ts` solo llama a `withBi(app)` y `attachBiRealtime(httpServer)` (ver `index.ts`).
- **Apagado** (`BI_ENABLED` distinto de `true`, como la app de producción): no se carga ningún
  módulo del BI, no hay rutas `/bi`, pools, poller ni WebSocket. `/bi/*` da el 404 de qeb-Back.
- **Encendido**: las peticiones a `/bi/*` se despachan a la app del BI antes de Express de
  qeb-Back (su CORS, helmet, timeouts y 404 no se mezclan). El WebSocket del historial vive en
  `/bi/ws/historial` con `ws` en modo `noServer`, sin tocar los upgrades de socket.io.
- Si faltan variables o `BI_JWT_SECRET` coincide con un secreto de qeb-Back, el BI no se monta
  (se registra `[BI] ...` en el log) y qeb-Back sigue normal.

## Variables

Todas llevan prefijo `BI_` (ver `.env.example` de esta carpeta) y se ponen en el `.env` de
qeb-Back o en el componente `qeb-back` de DigitalOcean. El BI nunca lee `DATABASE_URL`,
`JWT_SECRET`, `PORT` ni el CORS de qeb-Back. `BI_JWT_SECRET` es obligatoria (mínimo 32
caracteres) y distinta de la de qeb-Back.

## Local

Con las `BI_*` en el `.env` de qeb-Back, al levantar qeb-Back el BI queda en
`http://localhost:3000/bi`. En bi-front: `VITE_API_URL=http://localhost:3000/bi`.

## Despliegue (DigitalOcean App Platform)

No hay componente ni costo aparte: basta agregar las `BI_*` (con `BI_ENABLED=true`) al
componente `qeb-back` de la app. En bi-front: `VITE_API_URL=https://<host-de-la-app>/bi`
(sin `/` final) y redeploy. Para apagarlo: quitar `BI_ENABLED` y redeployar.

## Endpoints

Todos cuelgan de `/bi` (p. ej. `/bi/health`, `/bi/auth/login`, `wss://<host>/bi/ws/historial`).

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
