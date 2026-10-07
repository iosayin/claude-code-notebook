# claude-code-notebook (Türkçe)

**Claude Code, bağlam sıkıştırıldıktan sonra ne yaptığını unutur. Bu araç bunu çözer.**

Her oturuma küçük bir Markdown çalışma defteri ve iki kanca verir:

- **Sıkıştırmadan önce** son istekleri, düzenlenen dosyaları ve Claude'un son cevabını deftere yazar (sırlar maskelenir).
- **Sıkıştırma ya da devamdan sonra** defterin tamamını Claude'un bağlamına geri koyar; iş, özetin hatırladığından değil defterde yazandan devam eder.
- **Başlangıçta** defterin yerini söyler, güncel tutmasını ister ve aynı projede başka oturumların açık bıraktığı defterleri listeler.

## Kurulum

```bash
npx claude-code-notebook install
```

Claude Code'u yeniden başlatın. Defterler repo dışında, `~/.claude/notebooks/<proje>/<oturum>.md` altında durur. Ağ bağlantısı yok, telemetri yok, bağımlılık yok.

Ayrıntılar, ayarlar ve gizlilik notları için [README.md](README.md).
