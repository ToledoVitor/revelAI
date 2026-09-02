const argumentsList = process.argv.slice(2);

console.log(JSON.stringify(argumentsList));

if (argumentsList.includes("--fail")) {
  process.exitCode = 17;
}
