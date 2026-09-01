import { describe, expect, it } from "vitest";
import { warningsFromExecutionRole } from "../../src/adapters/postgres-readonly-tools.js";

describe("PostgresReadonlyTools role warnings", () => {
  it("convierte un rol superusuario en DATABASE_ROLE_UNSAFE no bloqueante", () => {
    expect(warningsFromExecutionRole({ superuser: true, unsafe_server_role: false })).toEqual([
      {
        code: "DATABASE_ROLE_UNSAFE",
        message:
          "El rol PostgreSQL es superusuario; la lectura continúa dentro de una transacción READ ONLY.",
      },
    ]);
  });

  it("no advierte para un rol sin privilegios elevados", () => {
    expect(warningsFromExecutionRole({ superuser: false, unsafe_server_role: false })).toEqual([]);
  });
});
