# egern文件夹下文档说明

# 规则类文件 自用版
Adblock_merge/China_Direct/rewrite egern直接添加模块使用
1. Reject和Direct不涉及分流考量，直接引用最为便捷
2. 聚合了多个数据源（可能有重复），尽可能做到一步到位
3. rewrite文件可以不引用（不一定有效）
## Adblock_merge
https://raw.githubusercontent.com/fantafender/rule_collections/refs/heads/main/egern/Adblock_Merge.yaml
## China_Direct
https://raw.githubusercontent.com/fantafender/rule_collections/refs/heads/main/egern/China_Direct.yaml
## rewrite test
https://github.com/fantafender/rule_collections/blob/main/egern/rewrite.yaml
# JS文件夹
## Network_monitor  egern小组件稳定版（脚本-通用）
1. 通过直连ip获取ASN来确定实际运营商
2. 切换节点后刷新，留有1200ms容错来获取网络数据
https://raw.githubusercontent.com/fantafender/rule_collections/refs/heads/main/egern/js/Network_monitor

## network_ultra 

https://raw.githubusercontent.com/fantafender/rule_collections/refs/heads/main/egern/js/network_ultra
1. 显示RTT延迟及接口延
2. 并发处理数据
3. 增强了全球运营商显示

