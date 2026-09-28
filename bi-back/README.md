# bi-back

Backend del BI de QEB. Sirve el **Resumen de Ventas** leyendo la vista `V_APS_Globales`
de QEB (**solo SELECT**) y expone una **meta mensual editable** (`bi_presupuesto`, tabla
nueva y aislada — la única escritura).

## Correr

```bash
cp .env.example .env      # llena DB_PASSWORD (y CORS_ORIGIN del front)
npm install
npm run dev               # http://localhost:3001
```

Para **construir/producción**: `npm run build && npm start`.

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
- **Definición de venta**: `VENTA_DEF=TOTAL` (todo el Monto Total) o `VENTA` (solo `U_dscTAsig='Venta'`).
- **Semana**: ISO−1 (convención IMU) sobre `Fecha`. Cambiar `USA_SEMANA_IMU` en el service si no.
- **SAP**: el filtro existe en el front pero QEB no tiene base `SAP` (solo CIMU/TRADE).
