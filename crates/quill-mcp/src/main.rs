fn main() {
    // Accept both `quill-mcp` and `quill-mcp mcp` (existing client config
    // entries pass `args: ["mcp"]` from the 1.x single-binary CLI).
    let mut args = std::env::args().skip(1);
    if let Some(arg) = args.next() {
        if arg != "mcp" || args.next().is_some() {
            eprintln!("usage: quill-mcp [mcp]");
            std::process::exit(2);
        }
    }
    quill_core::mcp_stdio_main();
}
