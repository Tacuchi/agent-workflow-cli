/**
 * El registro de proveedores de autenticación: la única fuente que se consulta.
 *
 * El proveedor de diagnóstico de `tools-auth` lee de acá qué hay que autenticar y
 * qué flujo declaró cada proveedor. Que sea uno solo es la promesa: dos listas de
 * «qué se autentica» terminan discrepando, y la que se olvide de un sujeto lo va
 * a declarar sano por omisión.
 *
 * No hay una búsqueda por id, y su ausencia es deliberada. El ejecutor de flujos
 * NO vuelve acá a resolver qué correr: corre el `argv` que quedó sellado en la
 * acción, porque aprobar un lote que ejecuta un comando es aprobar sus tokens
 * exactos y el digest lo aprobó una persona en otro proceso. Hubo una función
 * `doctorAuthProvider(id)` para ese uso y se retiró al comprobar que ningún
 * camino de producción la llamaba: una API que sólo su propia prueba ejercita
 * hace creer que existe una resolución por id que no existe.
 *
 * Vive en la aplicación y no en el dominio, aunque el contrato sí sea del
 * dominio: un proveedor real necesita el contexto del CLI para leer el entorno,
 * y el dominio no puede depender de la aplicación. El contrato es genérico sobre
 * ese contexto justamente para que el corte quede donde corresponde.
 */
import type { CliContext } from "../../cli/types.js";
import type { DoctorAuthProvider } from "../../domain/doctor/auth.js";
import { dsnAuthProvider } from "./auth-dsn.js";

/** El contrato del dominio, instanciado con el contexto que este CLI tiene. */
export type DoctorAuthCliProvider = DoctorAuthProvider<CliContext>;

/**
 * Los proveedores reales, y hoy hay exactamente uno.
 *
 * Ninguno declara flujo. No es una omisión: autenticar lo único autenticable de
 * este CLI es exportar una cadena que sólo la persona conoce, y cualquier
 * comando que el CLI corriera para conseguirla tendría que custodiarla. La
 * maquinaria de flujos existe probada con un doble, y el catálogo real declara
 * que no la usa.
 */
export const DOCTOR_AUTH_PROVIDERS: readonly DoctorAuthCliProvider[] = [dsnAuthProvider];
