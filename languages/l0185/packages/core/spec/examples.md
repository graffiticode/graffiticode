<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0185 RAG Training Examples

117 example prompts for training a RAG model on L0185, the fetch-and-shape data language. Each numbered line is a request in the author's own voice; it says what data to get and how to shape it, never how to write the program.

## Category 1: Fetch (1–8)

1. Fetch JSON data from "https://l0185.graffiticode.org/data/users.json".
2. Fetch CSV data from "https://l0185.graffiticode.org/data/iris.csv".
3. Fetch JSON data from "https://l0185.graffiticode.org/data/products.json".
4. Fetch post data from "https://l0185.graffiticode.org/data/posts.json".
5. Fetch todo data from "https://l0185.graffiticode.org/data/todos.json".
6. Fetch comment data from "https://l0185.graffiticode.org/data/comments.json".
7. Fetch photo data from "https://l0185.graffiticode.org/data/photos.json".
8. Fetch album data from "https://l0185.graffiticode.org/data/albums.json".

## Category 2: Filter (9–24)

9. Fetch todos from "https://l0185.graffiticode.org/data/todos.json" and filters rows where completed equals true.
10. Fetch users from "https://l0185.graffiticode.org/data/users.json" and filters rows where address.city equals "Gwenborough".
11. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and filters rows where price is less than 50.
12. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and filters rows where sepal_length is greater than 5 and sepal_width is greater than 3.
13. Fetch users from "https://l0185.graffiticode.org/data/users.json" and filters rows where name contains "Leanne".
14. Fetch comments from "https://l0185.graffiticode.org/data/comments.json" and filters rows where email ends with ".biz".
15. Fetch users from "https://l0185.graffiticode.org/data/users.json" and filters rows where name starts with "C".
16. Fetch todos from "https://l0185.graffiticode.org/data/todos.json" and filters rows where completed is not equal to true.
17. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and filters rows where rating is greater than or equal to 4.5.
18. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and filters rows where stock is less than or equal to 10.
19. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and filters rows where category equals "furniture" and price is greater than 30.
20. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and filters rows where userId equals 1.
21. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and filters rows where rating is greater than 4 and category equals "smartphones".
22. Fetch users from "https://l0185.graffiticode.org/data/users.json" and filters rows where address.city equals "South Elvis".
23. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and filters rows where category is in ["furniture", "groceries", "smartphones"].
24. Fetch users from "https://l0185.graffiticode.org/data/users.json" and filters rows where address.city is not in ["Gwenborough", "South Elvis", "Wisokyburgh"].

## Category 3: Select (25–34)

25. Fetch users from "https://l0185.graffiticode.org/data/users.json" and selects name and email.
26. Fetch users from "https://l0185.graffiticode.org/data/users.json" and selects name, email, and phone.
27. Fetch users from "https://l0185.graffiticode.org/data/users.json" and selects company.name and name.
28. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and renames title to name.
29. Fetch users from "https://l0185.graffiticode.org/data/users.json" and selects address.city and address.zipcode.
30. Fetch users from "https://l0185.graffiticode.org/data/users.json", renames company.name to companyName, and selects name.
31. Fetch comments from "https://l0185.graffiticode.org/data/comments.json" and selects only the email field.
32. Fetch todos from "https://l0185.graffiticode.org/data/todos.json" and selects id, title, and completed.
33. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and renames userId to author and selects title.
34. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and selects category and price.

## Category 4: Mutate (35–48)

35. Fetch users from "https://l0185.graffiticode.org/data/users.json" and adds a label field by concatenating name, " <", and email, and ">".
36. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and adds a salePrice field by multiplying price and discountPercentage, rounded to 2.
37. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and adds a sepal_area field by multiplying sepal_length and sepal_width, rounded to 2.
38. Fetch todos from "https://l0185.graffiticode.org/data/todos.json" and adds a source field with the literal value "jsonplaceholder".
39. Fetch users from "https://l0185.graffiticode.org/data/users.json" and adds a contact field by concatenating name, " (", phone, and ")".
40. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and adds a totalValue field by multiplying price and stock, rounded to 2.
41. Fetch users from "https://l0185.graffiticode.org/data/users.json" and adds an info field by concatenating username, " - ", website.
42. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and adds a petal_area field by multiplying petal_length and petal_width.
43. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and adds a total_length field by summing sepal_length and petal_length, rounded to 1.
44. Fetch users from "https://l0185.graffiticode.org/data/users.json" and adds a greeting field by concatenating "Hello, " and name.
45. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and adds a discount field by subtracting price and salePrice, rounded to 2.
46. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and adds a pricePerUnit field by dividing price and stock, rounded to 2.
47. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and adds a sepal_ratio field by dividing sepal_length and sepal_width, rounded to 2.
48. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and adds a length_diff field by subtracting sepal_length and petal_length, rounded to 2.

## Category 5: Group (49–60)

49. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and groups by category counting rows as n.
50. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and groups by species computing average sepal_length rounded to 2.
51. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and groups by species counting rows as count and computing average petal_length.
52. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and groups by userId counting rows as postCount.
53. Fetch todos from "https://l0185.graffiticode.org/data/todos.json" and groups by userId counting rows as totalTodos.
54. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and groups by species computing min and max of sepal_length.
55. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and groups by category computing average rating rounded to 1.
56. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and groups by category summing stock as totalStock.
57. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and groups by species computing average petal_width.
58. Fetch comments from "https://l0185.graffiticode.org/data/comments.json" and groups by postId counting rows as commentCount.
59. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and groups by category summing price as totalPrice.
60. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and groups by category computing average price rounded to 2.

## Category 6: Sort (61–68)

61. Fetch users from "https://l0185.graffiticode.org/data/users.json" and sorts by name ascending.
62. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and sorts by price descending.
63. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and sorts by sepal_length ascending.
64. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and sorts by rating descending.
65. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and sorts by title ascending.
66. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv" and sorts by petal_length descending.
67. Fetch users from "https://l0185.graffiticode.org/data/users.json" and sorts by username.
68. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and sorts by stock descending.

## Category 7: Take (69–74)

69. Fetch photos from "https://l0185.graffiticode.org/data/photos.json" and takes the first 10 items.
70. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and takes the first 5 items.
71. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and takes the last 3 items.
72. Fetch comments from "https://l0185.graffiticode.org/data/comments.json" and takes the first 20 items.
73. Fetch todos from "https://l0185.graffiticode.org/data/todos.json" and takes the last 10 items.
74. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, sorts by price descending, and takes the first 1 item.

## Category 8: Join (75–78)

75. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and joins with users fetched from "https://l0185.graffiticode.org/data/users.json" on userId matching id.
76. Fetch comments from "https://l0185.graffiticode.org/data/comments.json" and joins with posts fetched from "https://l0185.graffiticode.org/data/posts.json" on postId matching id.
77. Fetch photos from "https://l0185.graffiticode.org/data/photos.json" and joins with albums fetched from "https://l0185.graffiticode.org/data/albums.json" on albumId matching id, keeping each photo's title and its album's title.
78. Fetch albums from "https://l0185.graffiticode.org/data/albums.json" and joins with users fetched from "https://l0185.graffiticode.org/data/users.json" on userId matching id.

## Category 9: Get (79–84)

79. Fetch products from "https://l0185.graffiticode.org/data/products.json" and gets the "products" field.
80. Fetch users from "https://l0185.graffiticode.org/data/users.json" and gets the "address.city" field.
81. Fetch users from "https://l0185.graffiticode.org/data/users.json" and gets the "company.name" field.
82. Fetch users from "https://l0185.graffiticode.org/data/users.json" and gets the "address.geo" field.
83. Fetch products from "https://l0185.graffiticode.org/data/products.json" and gets the "products.title" field.
84. Fetch users from "https://l0185.graffiticode.org/data/users.json" and gets the "address" field.

## Category 10: Flatten (85–88)

85. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and flattens the "tags" field.
86. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and flattens the "images" field.
87. Fetch users from "https://l0185.graffiticode.org/data/users.json" and flattens nested arrays to depth 1.
88. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and flattens the "reviews" field.

## Category 11: Unique (89–92)

89. Fetch comments from "https://l0185.graffiticode.org/data/comments.json" and deduplicates by email.
90. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and deduplicates by category and brand.
91. Fetch posts from "https://l0185.graffiticode.org/data/posts.json" and deduplicates by userId.
92. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and deduplicates by category.

## Category 12: Pipelines (93–106)

93. Fetch users from "https://l0185.graffiticode.org/data/users.json", selects name and email, and sorts by name.
94. Fetch todos from "https://l0185.graffiticode.org/data/todos.json", filters where completed equals true, and sorts by title.
95. Fetch todos from "https://l0185.graffiticode.org/data/todos.json", filters where completed equals true, groups by userId, and counts rows as completedCount.
96. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv", filters where sepal_length is greater than 6, and sorts by sepal_length descending.
97. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, selects title and rating, sorts by rating descending, and takes the first 5.
98. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, filters where price is greater than 100, selects title and price, and sorts by price descending.
99. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, groups by category and sums price as totalPrice rounded to 2, and sorts by totalPrice descending.
100. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, filters where rating is greater than or equal to 4, and selects title and price.
101. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv", groups by species and computes average sepal_length rounded to 2, and sorts by sepal_length descending.
102. Fetch todos from "https://l0185.graffiticode.org/data/todos.json", groups by userId and counts as totalTodos, sorts by totalTodos descending, and takes the first 3.
103. Fetch users from "https://l0185.graffiticode.org/data/users.json", adds a label field by concatenating name, " <", email, and ">", and selects label and phone.
104. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, groups by category computing average rating rounded to 1, sorts by rating descending, and takes the first 5.
105. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, flattens the "tags" field, deduplicates by tags, and sorts by tags.
106. Fetch comments from "https://l0185.graffiticode.org/data/comments.json", deduplicates by email, selects name and email, and sorts by email.

## Category 13: Format (107–117)

107. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and formats price as "$#,##0.00".
108. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, adds a salePrice field by multiplying price and discountPercentage rounded to 2, and formats salePrice as "$#,##0.00".
109. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and formats stock as "#,##0".
110. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv", adds a sepal_area field by multiplying sepal_length and sepal_width rounded to 2, and formats sepal_area as "0.00".
111. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, mutates discountRate by dividing discountPercentage by 100, and formats discountRate as "0.0%".
112. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, groups by category and sums price as totalPrice rounded to 2, sorts by totalPrice descending, and formats totalPrice as "$#,##0.00".
113. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, and formats price as "#,##0.00;(#,##0.00)".
114. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, selects title and price, formats price as "$#,##0", and sorts by title.
115. Fetch iris data from "https://l0185.graffiticode.org/data/iris.csv", groups by species and computes average sepal_length rounded to 2, and formats sepal_length as "0.00".
116. Fetch products from "https://l0185.graffiticode.org/data/products.json", gets the "products" field, selects title, price, and rating, formats price as "$#,##0.00" and rating as "0.0", and takes the first 10.
117. Fetch earthquake data from "https://l0185.graffiticode.org/data/earthquakes.json", gets the "features" field, selects "properties.place", "properties.mag", and "properties.time", and formats time as "yyyy-mm-dd hh:mm".
