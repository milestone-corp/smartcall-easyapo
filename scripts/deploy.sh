#!/bin/bash
#
# scripts/deploy.sh
#
# 本番店舗デプロイスクリプト（店舗ID指定）
#
# 使い方:
#   ./scripts/deploy.sh 57               # 小西歯科 本番
#   ./scripts/deploy.sh 165              # ビーンズ歯科 本番
#   ./scripts/deploy.sh 57 --dry-run     # 実行内容だけ表示
#   SKIP_GIT_SYNC=1 ./scripts/deploy.sh 57   # main 同期チェックをスキップ
#
# ※ Staging 環境へのデプロイは scripts/deploy-staging.sh を使用すること
#
# 前提:
#   - envs/<SHOP_ID>-<NAME>.env が存在すること
#   - SSH 鍵が DEPLOY_SSH_KEY のパスで利用可能なこと
#   - 踏み台→RPAサーバへ二段SSHできること
#
# 設計（複数院同居対応）:
#   - 同一サーバに複数院が同居する（RPA01: watai/konishi/ikeda、RPA04: beans/yuki）。
#   - 各院を別 compose project として隔離するため COMPOSE_PROJECT_NAME を店舗別に設定。
#   - --remove-orphans は使わない（他院コンテナを巻き込むため）。
#   - 旧 docker-compose.{prod,beans-shika,yuki-dental}.yml から移行する初回のみ、
#     同名・同ポートの旧コンテナを手動で停止・削除しておくこと（runbook 参照）。
#
# 処理内容:
#   1. envs/ から該当 env を見つけて .env にコピー
#   2. ローカル/GitHubの状態確認
#   3. tarball 作成（envs/, .git, node_modules 等を除外）
#   4. 踏み台 → RPAサーバへ転送
#   5. RPAサーバで展開、docker-compose.shop.yml で build & up（店舗別project）
#   6. ヘルスチェック
#

set -e

# 色付き出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_PATH="$(dirname "$SCRIPT_DIR")"
TEMP_DIR="/tmp"

# ===== 引数チェック =====
TARGET="${1:-}"
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
    esac
done

if [ -z "$TARGET" ] || [[ "$TARGET" == --* ]]; then
    echo -e "${RED}使い方: ./scripts/deploy.sh <店舗ID> [--dry-run]${NC}"
    echo ""
    echo "利用可能な店舗:"
    ls "$LOCAL_PATH/envs/" 2>/dev/null | grep -vE '_template|.gitkeep|staging' | sed 's/^/  - /'
    echo ""
    echo "Staging へのデプロイは ./scripts/deploy-staging.sh を使用してください"
    exit 1
fi

# staging は専用スクリプトへ誘導
if [ "$TARGET" = "staging" ]; then
    echo -e "${RED}エラー: staging は ./scripts/deploy-staging.sh を使用してください${NC}"
    exit 1
fi

# ===== envs から該当ファイルを特定（数字IDで glob: envs/<ID>-*.env）=====
ENV_FILE=$(ls "$LOCAL_PATH"/envs/"${TARGET}"-*.env 2>/dev/null | head -1)

if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}エラー: envs/${TARGET}-*.env が見つかりません${NC}"
    echo "利用可能な店舗:"
    ls "$LOCAL_PATH/envs/" 2>/dev/null | grep -vE '_template|.gitkeep|staging' | sed 's/^/  - /'
    exit 1
fi

# .env にコピーして読み込み
cp "$ENV_FILE" "$LOCAL_PATH/.env"
set -a; . "$LOCAL_PATH/.env"; set +a

# 必須変数チェック
for var in SHOP_ID SHOP_NAME SHOP_PORT DEPLOY_HOST DEPLOY_USER DEPLOY_BASTION_HOST DEPLOY_BASTION_USER DEPLOY_SSH_KEY; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}エラー: $var が $ENV_FILE で未設定です${NC}"
        exit 1
    fi
done

# SSH鍵パス展開（~ → $HOME）
SSH_KEY="${DEPLOY_SSH_KEY/#\~/$HOME}"

# tarballとリモートパスの命名
TARBALL_NAME="smartcall-easyapo-${SHOP_NAME}.tar.gz"
REMOTE_PATH="/home/${DEPLOY_USER}/smartcall-easyapo"
CONTAINER="${CONTAINER_NAME:-smartcall-easyapo-${SHOP_NAME}}"
# 複数院同居サーバで各院を別 compose project として隔離する（store間の相互置換を防止）
COMPOSE_PROJECT="smartcall-easyapo-${SHOP_NAME}"

# ===== バナー =====
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}EasyApo RPA デプロイ${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "店舗ID:       ${GREEN}${SHOP_ID}${NC} (${SHOP_NAME})"
echo -e "env file:     ${ENV_FILE}"
echo -e "デプロイ先:   ${DEPLOY_USER}@${DEPLOY_HOST}:${SHOP_PORT}"
echo -e "コンテナ名:   ${CONTAINER}"
echo -e "composeproj:  ${COMPOSE_PROJECT}"
echo -e "踏み台:       ${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}"
echo -e "SSH鍵:        ${SSH_KEY}"

if [ "$DRY_RUN" = "1" ]; then
    echo -e "\n${YELLOW}--dry-run なので実際のデプロイは行いません${NC}"
    exit 0
fi

# ===== 1. ローカル状態確認 =====
echo -e "\n${YELLOW}[1/6] ローカルリポジトリの確認${NC}"
cd "$LOCAL_PATH"

if [ -d ".git" ]; then
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        echo -e "${YELLOW}警告: コミットされていない変更があります${NC}"
        git status --short
        read -p "続行しますか？ (y/N): " confirm
        [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && { echo "キャンセルしました"; exit 0; }
    fi
    CURRENT_COMMIT=$(git log -1 --format='%h %s' 2>/dev/null || echo "N/A")
    echo -e "現在のコミット: ${GREEN}${CURRENT_COMMIT}${NC}"
else
    CURRENT_COMMIT="N/A"
fi

# ===== 2. GitHub同期確認 =====
echo -e "\n${YELLOW}[2/6] GitHubとの同期確認${NC}"
if [ "${SKIP_GIT_SYNC:-0}" = "1" ]; then
    echo -e "${YELLOW}SKIP_GIT_SYNC=1 のためスキップ${NC}"
elif [ -d ".git" ]; then
    git fetch origin 2>/dev/null || true
    LOCAL_HASH=$(git rev-parse HEAD 2>/dev/null || echo "")
    REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null || echo "")
    if [ -n "$LOCAL_HASH" ] && [ -n "$REMOTE_HASH" ] && [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
        echo -e "${YELLOW}ローカルとリモート(main)に差分があります${NC}"
        echo "ローカル: $LOCAL_HASH"
        echo "main:     $REMOTE_HASH"
        read -p "続行しますか？ (y/N): " confirm
        [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && { echo "キャンセルしました"; exit 0; }
    else
        echo -e "${GREEN}main と一致${NC}"
    fi
fi

# ===== 3. tarball 作成 =====
echo -e "\n${YELLOW}[3/6] ソースコードをtarballに圧縮${NC}"
tar --no-xattrs -czf "$TEMP_DIR/$TARBALL_NAME" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='screenshots/*' \
    --exclude='input/*' \
    --exclude='output/*' \
    --exclude='envs' \
    --exclude='.playwright-mcp' \
    --exclude='.claude' \
    --exclude='.DS_Store' \
    .
echo -e "作成完了: $TEMP_DIR/$TARBALL_NAME"
ls -lh "$TEMP_DIR/$TARBALL_NAME"

# ===== 4. 踏み台へ転送 =====
echo -e "\n${YELLOW}[4/6] 踏み台サーバに転送${NC}"
scp -i "$SSH_KEY" "$TEMP_DIR/$TARBALL_NAME" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}:${TEMP_DIR}/"
echo -e "${GREEN}踏み台への転送完了${NC}"

# ===== 5. 踏み台 → RPAサーバ転送・展開 =====
echo -e "\n${YELLOW}[5/6] RPAサーバ (${DEPLOY_HOST}) に転送・展開${NC}"

ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'mkdir -p ${REMOTE_PATH}'"

ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "scp -i ~/.ssh/milestone ${TEMP_DIR}/${TARBALL_NAME} ${DEPLOY_USER}@${DEPLOY_HOST}:${TEMP_DIR}/"

ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'cd ${REMOTE_PATH} && tar -xzf ${TEMP_DIR}/${TARBALL_NAME}'"
echo -e "${GREEN}tarball展開完了${NC}"

# ===== 6. docker compose build & up =====
# COMPOSE_PROJECT_NAME を店舗別にして各院を隔離（--remove-orphans は使わない:他院を巻き込むため）
echo -e "\n${YELLOW}[6/6] Dockerイメージビルド・コンテナ起動${NC}"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'cd ${REMOTE_PATH} && sudo COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT} docker compose -f docker-compose.shop.yml build && sudo COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT} docker compose -f docker-compose.shop.yml up -d'"

# コンテナ状態確認
echo -e "\nコンテナ状態:"
sleep 3
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'sudo docker ps --filter name=${CONTAINER} --format \"table {{.Names}}\t{{.Status}}\t{{.Ports}}\"'"

# ヘルスチェック
echo -e "\n${YELLOW}ヘルスチェック実行${NC}"
sleep 5
HEALTH_RESULT=$(ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'curl -s http://localhost:${SHOP_PORT}/health'" 2>/dev/null || echo "failed")

if echo "$HEALTH_RESULT" | grep -q '"status"'; then
    echo -e "${GREEN}ヘルスチェック OK${NC}"
    echo "$HEALTH_RESULT" | (jq . 2>/dev/null || cat)
else
    echo -e "${RED}ヘルスチェック NG${NC}"
    echo "$HEALTH_RESULT"
    echo -e "\nログ確認:"
    echo -e "  ssh -i ${SSH_KEY} ${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST} \"ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'sudo docker logs --tail 50 ${CONTAINER}'\""
fi

# ===== クリーンアップ =====
echo -e "\n${YELLOW}一時ファイルのクリーンアップ${NC}"
rm -f "$TEMP_DIR/$TARBALL_NAME"
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" "rm -f ${TEMP_DIR}/${TARBALL_NAME}" || true
ssh -i "$SSH_KEY" "${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST}" \
    "ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'rm -f ${TEMP_DIR}/${TARBALL_NAME}'" || true

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}デプロイ完了${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "店舗ID:       ${SHOP_ID} (${SHOP_NAME})"
echo -e "コミット:     ${CURRENT_COMMIT}"
echo -e "URL:          http://${DEPLOY_HOST}:${SHOP_PORT}"
echo ""
echo -e "ログ確認コマンド:"
echo -e "  ssh -i ${SSH_KEY} ${DEPLOY_BASTION_USER}@${DEPLOY_BASTION_HOST} \"ssh -i ~/.ssh/milestone ${DEPLOY_USER}@${DEPLOY_HOST} 'sudo docker logs --tail 50 -f ${CONTAINER}'\""
