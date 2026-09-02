<div align="center">

<p align="right">
   <a href="../README.md">English</a> | <a href="./README.cn.md">中文</a> | <strong>日本語</strong>
</p>

# TokenTest

### 本番投入前に、モデル・ルート・使用量・安全性を検証します。

AI ルーター、調達チーム、CI パイプライン向けのブラックボックスモデル検証ツールです。

[オンラインで実行](https://tokentest.io) · [製品マニュアル](https://tokentest.io/manual.html) · [リモート MCP](https://tokentest.io/docs/remote-mcp.md) · [GitHub](https://github.com/SolveaCX/tokentest.io)

![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-supported-6e56cf)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

<br>

🚀 **[TokenTest をオンラインで実行 →](https://tokentest.io)**

</div>

TokenTest は、AI 中間層を選定するチーム向けの本番リファレンス評価レイヤーです。OpenAI-compatible または Anthropic 形式のルーターを外部からテストし、要求したモデルと実際に返されたモデルを比較し、Token 使用量、安全性、チャネル動作を検証して、本番導入判断に使える証拠を作成します。

TokenTest は AI ゲートウェイそのものではありません。アプリのトラフィックをプロキシしたり、プロバイダーキーを管理したり、上流 SLA を保証したりしません。ルートをゲートウェイの背後に置く前に、信頼性を確認するためのツールです。

<div align="center"><img src="../assets/preview-run.png" width="760" alt="TokenTest 評価コンソール" /></div>

## TokenTest でできること

- Web コンソールから単一モデルまたは複数モデルを評価。
- OpenAI-compatible `/models` エンドポイントからモデルを検出。
- サイレントなモデル降格、プロトコル不一致、不自然な Token 使用量、エンドポイント障害を検出。
- ID、決定的出力、チャネル、Token、安全性、安定性の 6 つの本番リファレンス軸を確認。
- `npx tokentest evaluate` で CI の厳格な導入ゲートを実行。
- Claude Desktop、Cursor、VS Code などの MCP クライアントから利用。
- 調達、リリースレビュー、インシデント対応向けに JSON、CSV、HTML、JUnit を出力。
- API Key と認証の生データを保存せず、ブラウザ内だけに履歴を保持。

## クイックスタート

### 1. オンライン評価コンソールを開く

[tokentest.io](https://tokentest.io) にアクセスし、ルーター URL、テスト専用キー、モデル ID を入力します。ルーターが `/models` を公開していればモデルを自動検出できます。

### 2. CI で導入判定を実行

```bash
TOKENTEST_BASE_URL="https://api.example.com/v1" \
TOKENTEST_API_KEY="$MODEL_API_KEY" \
TOKENTEST_MODELS="model-a,model-b" \
npx tokentest evaluate \
  --min-score 80 \
  --format junit \
  --output tokentest.junit.xml
```

すべてのモデルがスコア閾値を満たし、`production_reference_pass` となり、重要な ID・認証・Token ゲートに失敗せず、評価を完了した場合のみ終了コード `0` になります。

### 3. ローカルで実行

```bash
git clone https://github.com/SolveaCX/tokentest.io.git
cd tokentest.io
npm install
npm start
```

コンソールは `http://localhost:8080`、ローカル stdio MCP は次で起動します。

```bash
npm run mcp
```

## CLI リファレンス

コマンドライン引数は環境変数より優先されます。

| オプション | 環境変数 | 説明 |
| --- | --- | --- |
| `--base-url <url>` | `TOKENTEST_BASE_URL` | ルーターのベース URL。 |
| `--api-key <key>` | `TOKENTEST_API_KEY` | 上流ルーター/モデルキー。実行中のメモリだけで使用。 |
| `--model <id>` | `TOKENTEST_MODELS` | 繰り返し指定またはカンマ区切りのモデル ID。 |
| `--provider openai\|anthropic` | `TOKENTEST_PROVIDER` | 任意のプロトコルヒント。 |
| `--min-score 0..100` | `TOKENTEST_MIN_SCORE` | 最低スコア。既定値は `80`。 |
| `--deep` | — | より深いカバレッジを有効化。 |
| `--format summary\|json\|junit` | `TOKENTEST_FORMAT` | 出力形式。既定値は `summary`。 |
| `--output <file>` | `TOKENTEST_OUTPUT` | 指定ファイルに保存。 |

終了コードは `0`（全モデル合格）、`1`（評価完了だが不合格あり）、`2`（設定不正）、`3`（評価不能または評価エラー）です。

## 6 つの本番リファレンス評価軸

| 軸 | 重み | 検証内容 |
| --- | ---: | --- |
| **D1 · Identity & Protocol Integrity** | 30% | 要求モデルと解決モデル、レスポンス構造、モデル一覧、Nonce リプレイ、Header、認証互換性。 |
| **D2 · Output Discipline & Deterministic Tasks** | 30% | 厳密 JSON、複数制約、言語、算術、論理、コード、表、反実仮想、証明チェック。 |
| **D3 · Channel & Output Integrity** | 5% | ツール、Vision、文書、Web Search、長文、SSE、Delta、thinking、終了シグナル。 |
| **D4 · Token Usage Integrity** | 15% | usage の存在、合計整合性、入力単調性、出力妥当性、上限連動、stream と cache の証拠。 |
| **D5 · Safety & Robustness** | 10% | 良性要求、Prompt injection、秘密情報保護、危険コード境界、エラー漏洩。 |
| **D6 · Stability, Reliability & Compliance** | 10% | 生成リスク、P50/P95/P99 レイテンシ、TTFT、短時間成功率。 |

高い総合スコアでも本番ゲートを上書きしません。P0/P1 の失敗や重要証拠の欠落はリスク判定に残ります。

## レポートと MCP

レポートは JSON、CSV、HTML、JUnit に対応しています。ネットワーク、認証、タイムアウトなどの評価エラーを、能力スコア `0` として隠すことはありません。

TokenTest はローカル stdio MCP とリモート Streamable HTTP MCP を提供します。

- `discover_models` — ルーターが公開するモデル ID を検出。
- `evaluate_model` — D1-D6、リスクゲート、カバレッジ、使用量、マスク済み証拠を返却。
- `evaluate_batch` — 複数モデルを評価し、サマリーを返却。

リモート MCP の限流、プライベートネットワーク保護、認証設定は [docs/remote-mcp.md](../docs/remote-mcp.md) を参照してください。

## プライバシー、安全性、ロードマップ

- 上流 API Key は実行中だけ使用し、ブラウザ履歴や CLI レポートには保存しません。
- リモート MCP の認証証拠はマスクされます。公開モードではオリジン検証、限流、バッチ上限、プライベート URL ブロックを適用します。
- ブラウザ履歴はローカル保存のみで、エクスポートと削除が可能です。
- 今後は定期回帰・トレンド、コスト比較、組織別ポリシー、チーム協業、音声/リアルタイム評価を予定しています。

## 開発とコントリビューション

```bash
npm install
npm start
npm run test:evaluator
npm run test:server
npm run test:mcp
npm run test:http-mcp
npm run test:e2e
npm run test:visual
```

スコアリングを変更する場合は、決定性のある fixture を追加し、真正性・本番互換性・任意チャネル証拠のどれに影響するかを説明してください。実際の API Key や認証ヘッダーを issue、レポート、スクリーンショット、fixture に含めないでください。

本プロジェクトは [Apache License 2.0](../LICENSE) の下で提供されます。TokenTest の名称とロゴは SolveaCX の商標であり、本ライセンスは製品識別子としての使用権を付与しません。
