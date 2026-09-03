const secret = process.env.DEMO_E2E_TEST_SECRET ?? "missing-test-secret";

console.error(`unsafe child setup output: ${secret}`);
throw new Error(`unsafe child setup failure: ${secret}`);
