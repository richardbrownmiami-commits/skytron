// existing code...

const helloToolSchema = z.object({
  hello: z.string(),
});

async function helloTool(input: z.infer<typeof helloToolSchema>) {
  return { output: "Hello World" };
}
